/**
 * Tabs, the panes inside them, and every operation that reshapes either.
 *
 * The split geometry lives in `tree.ts`; this file is about identity — which
 * panes exist, what kind each one is, which is focused, and which tab is on
 * screen. Kept apart because the tree is pure geometry and worth testing as
 * such, while this half is where ids are minted and defaults are decided.
 *
 * The reducer never touches pane *contents*. A terminal's half-typed command
 * and a notepad's text change on every keystroke, and routing those through
 * React state would re-render every tab on every character. They live in
 * `content.ts` instead, and are joined back up only when a snapshot is written.
 */

import type { AgentRecord } from "@/lib/agents";
import { newId } from "@/lib/utils";
import type { ThemeChoice } from "@/state/settings";
import {
  panesFor,
  toNode,
  windowTabId,
  type TmuxWindow,
} from "@/lib/tmuxControl";
import {
  type Axis,
  type DropEdge,
  type Direction,
  type Node,
  clampRatio,
  countPanes,
  graftTree,
  hasPane,
  layout,
  leaf,
  movePane as moveInTree,
  neighbor,
  paneIds,
  removePane,
  repointPane,
  resizeTarget,
  setRatio as setRatioInTree,
  splitPane as splitInTree,
  substituteTree,
} from "./tree";

export type PaneKind = "terminal" | "notepad" | "browser" | "image" | "media" | "model";

interface PaneCommon {
  id: string;
  /** Set by the pane itself — a shell's title, a page's title, a file name. */
  title?: string;
  /**
   * A theme for this pane alone, or absent for the default.
   *
   * Absent is the state every pane starts in and stays in until somebody
   * changes it, and it does not mean "no theme" — it is a live reference to the
   * tab, so the pane wears whatever the tab is wearing *and follows it when
   * that changes*. Only a pane someone has deliberately dressed holds a value
   * here. See `themeOf`, which is the whole rule.
   *
   * The innermost of the three levels: app, tab, pane. It is stored here rather
   * than in the settings file because it belongs to *this* pane in *this*
   * session, the way its working directory does; a preference is the thing you
   * would copy to another machine, and "the pane on the right is Solarized" is
   * not that.
   */
  theme?: ThemeChoice;
  /**
   * An icon chosen by hand for this pane, by program id — see `lib/programs`.
   *
   * Absent means "work it out", which is the state every pane starts in: the
   * icon then follows whatever the pane is actually running and changes when
   * that changes. A value here stops the guessing, because the user has said
   * what this pane is and that outranks anything inferred from a command line.
   */
  profile?: string;
  /**
   * A type size for this pane alone, or absent to follow the setting.
   *
   * The same shape as `theme`: absent is a live reference to the Settings
   * window's font size, and only a pane someone has zoomed holds a number.
   * Zooming from the keyboard is nearly always about the one pane you are
   * reading — a log you are squinting at, a notepad on a projector — and
   * resizing every shell in the window for it re-wraps a dozen things nobody
   * asked about.
   */
  fontSize?: number;
}

export interface TerminalPaneState extends PaneCommon {
  kind: "terminal";
  /** Last known working directory, so a restored tab reopens where it was. */
  cwd?: string;
  /** True once the shell has exited and the pane is only showing its remains. */
  exited?: boolean;
  /**
   * The last command line submitted in this pane.
   *
   * Kept in the pane rather than only in the history log because two live
   * features read it constantly: the icon, which is how a tab full of shells
   * becomes a tab running Claude and a tab watching a build, and the offer to
   * resume after a machine crash. Both want "what is this pane for" at a
   * glance, and neither is worth a file read.
   *
   * It is the last command *started*, not the one running: without shell
   * integration nothing says when a command ended. That suits both readers —
   * the pane is still "the Claude one" after Claude exits.
   */
  command?: string;
  /**
   * The tmux session this pane is attached to, when it is in one.
   *
   * Persisted, and it is the field that makes a tmux-backed pane worth having:
   * a restored pane reattaches to a session that never stopped running, so what
   * comes back is the shell itself rather than a picture of what it printed.
   * Absent for an ordinary pane, which is the default.
   */
  tmux?: string;
  /**
   * tmux's own id for this pane, as `%3`, when jterm is drawing tmux's panes
   * as its own — control mode. See `lib/tmuxControl.ts`.
   *
   * `tmux` alone means tmux is running *inside* this pane and drawing itself.
   * `tmux` and this together mean the pane has no pty at all: its bytes arrive
   * from the one control client the session shares, and it must not be spawned.
   * The distinction is the whole of what `TerminalPane` needs to tell them
   * apart.
   */
  tmuxPane?: string;
  /**
   * The agent running in this pane when it was last looked at — see
   * `lib/agents.ts`.
   *
   * Kept for the day the pane's shell does not survive. It is what lets the
   * pane offer to resume *that* conversation, with the flags it was started
   * with, rather than whichever conversation in the directory happens to be the
   * most recent. Absent when nothing of the kind was running.
   */
  agent?: AgentRecord;
}

export interface NotepadPaneState extends PaneCommon {
  kind: "notepad";
  /** The file this pane edits. Absent for a scratch note, which has no home
   *  until it is saved somewhere. */
  path?: string;
  /** Set when the buffer differs from what is on disk. A scratch note with
   *  anything in it is always dirty — there is nowhere for it to match. */
  dirty?: boolean;
}

/** The three read-only viewers. Each is defined by the file it shows. */
export interface ImagePaneState extends PaneCommon {
  kind: "image";
  path: string;
}

export interface MediaPaneState extends PaneCommon {
  kind: "media";
  path: string;
}

export interface ModelPaneState extends PaneCommon {
  kind: "model";
  path: string;
}

export interface BrowserPaneState extends PaneCommon {
  kind: "browser";
  url: string;
}

export type PaneState =
  | TerminalPaneState
  | NotepadPaneState
  | BrowserPaneState
  | ImagePaneState
  | MediaPaneState
  | ModelPaneState;

export interface Tab {
  id: string;
  /** A name the user typed. Absent means the focused pane names the tab. */
  title?: string;
  /**
   * A theme for this tab and everything in it, or absent for the default.
   *
   * The same rule as a pane's, one level out: absent is where every tab starts
   * and stays until somebody changes it, and it is a live reference to the app
   * — the tab wears the app's theme and follows it when that changes. Only a
   * tab someone has deliberately dressed holds a value here.
   *
   * The middle of the three levels, and the one that makes switching tabs a
   * change of scenery: the window's chrome wears the active tab's theme, so a
   * tab set to Solarized repaints the strip and the sidebar as well as its own
   * panes. See `setTabTheme` in `lib/appearance.ts`.
   */
  theme?: ThemeChoice;
  /** An icon chosen by hand for the whole tab. Absent means the focused pane
   *  speaks for it, the same way it does for the tab's name. */
  profile?: string;
  root: Node;
  panes: Record<string, PaneState>;
  focusedPaneId: string;
  /** The pane temporarily filling the tab, tmux's `prefix z`. */
  zoomedPaneId: string | null;
}

/**
 * How much of the window a pop-up is showing.
 *
 * `minimized` keeps the pane alive and on the rail with only its header drawn,
 * which is the point of it: a shell you have stopped watching but have not
 * finished with. `full` fills the pane area, for the moment where the pop-up
 * has stopped being a glance and become the thing you are working in.
 */
export type PopupState = "open" | "minimized" | "full";

/**
 * A pane floating over the workspace rather than living in a tab.
 *
 * It belongs to the *window*, not to any tab, which is the whole feature:
 * switching tabs does not disturb it, so a file opened for reference stays in
 * front of you while you move around behind it.
 *
 * Geometry is stored as fractions of the pane area, never pixels, for the same
 * reason the split tree is: the window is resizable, and a pop-up parked at the
 * right edge of a wide window should still be at the right edge of a narrow
 * one. Only `x` moves — every pop-up sits on the rail along the bottom.
 */
export interface Popup {
  pane: PaneState;
  /** Left edge, as a fraction of the pane area's width. */
  x: number;
  /** Size, as fractions of the pane area. Ignored while `full`. */
  width: number;
  height: number;
  state: PopupState;
}

export interface Workspace {
  tabs: Tab[];
  activeTabId: string | null;
  /** Whether the file tree is showing. Persisted: a sidebar that closes itself
   *  on every launch is one the user has to reopen on every launch. */
  sidebarOpen: boolean;
  /**
   * The pop-ups over every tab, back to front. Raising one moves it to the end
   * rather than sorting on a z-index — the array *is* the order, so there is
   * only one thing to be wrong.
   */
  popups: Popup[];
  /**
   * The pop-up holding the keyboard, by pane id, or `null` when a tab's pane
   * has it.
   *
   * Focus cannot live in `Tab.focusedPaneId` alone once panes float over the
   * tabs: a tab always has a focused pane, and if that were the only answer
   * then clicking into a pop-up could not take the keyboard away from it.
   */
  focusedPopupId: string | null;
}

/**
 * Somewhere a pane can be sent.
 *
 * `tab` puts it in that tab beside whatever is focused there; `split` names the
 * pane to land next to, which is the same operation aimed precisely. Both exist
 * because the menu offers both, and the difference is only how much the user
 * cared to say.
 */
export type MoveTarget =
  | { kind: "popup" }
  | { kind: "tab"; tabId: string }
  | { kind: "newTab" }
  | { kind: "split"; paneId: string; axis?: Axis; before?: boolean };

/** Where a pop-up lands when it is made, and how big it starts. */
const POPUP_WIDTH = 0.36;
const POPUP_HEIGHT = 0.44;
/** Gap left at the right edge, so it reads as floating rather than docked. */
const POPUP_INSET = 0.015;
/** How far each further pop-up is dealt to the left of the last. */
const POPUP_STAGGER = 0.06;

export const HOME_PAGE = "https://duckduckgo.com";

/* ── Construction ────────────────────────────────────────────────────────── */

export function newPane(kind: PaneKind, seed?: Partial<PaneState>): PaneState {
  const id = newId();
  switch (kind) {
    case "notepad":
      return { id, kind: "notepad", ...(seed as object) };
    case "browser":
      return { id, kind: "browser", url: HOME_PAGE, ...(seed as object) };
    // The viewers cannot exist without a file, and `newPane` is only reached
    // for them by way of `openFile`, which always supplies one.
    case "image":
    case "media":
    case "model":
      return { id, kind, path: "", ...(seed as object) } as PaneState;
    case "terminal":
    default:
      return { id, kind: "terminal", ...(seed as object) };
  }
}

export function newTab(kind: PaneKind = "terminal", seed?: Partial<PaneState>): Tab {
  const pane = newPane(kind, seed);
  return {
    id: newId(),
    root: leaf(newId(), pane.id),
    panes: { [pane.id]: pane },
    focusedPaneId: pane.id,
    zoomedPaneId: null,
  };
}

export function emptyWorkspace(): Workspace {
  const tab = newTab("terminal");
  return {
    tabs: [tab],
    activeTabId: tab.id,
    sidebarOpen: false,
    popups: [],
    focusedPopupId: null,
  };
}

/**
 * A pop-up around a pane, placed where the last one is not.
 *
 * The first lands in the lower right, which is where a thing that must not be
 * in the way goes. Each further one is dealt to the left of it so a second
 * pop-up is not hidden underneath the first — clamped at the left edge, after
 * which they do stack, because a rail is only so long.
 */
export function newPopup(pane: PaneState, existing: number): Popup {
  const x = Math.max(0, 1 - POPUP_WIDTH - POPUP_INSET - existing * POPUP_STAGGER);
  return { pane, x, width: POPUP_WIDTH, height: POPUP_HEIGHT, state: "open" };
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export function activeTab(workspace: Workspace): Tab | null {
  return workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
}

export function focusedPane(tab: Tab): PaneState | null {
  return tab.panes[tab.focusedPaneId] ?? null;
}

/** Every pane in the window, tabs and pop-ups alike. */
export function allPanes(workspace: Workspace): PaneState[] {
  return [
    ...workspace.tabs.flatMap((tab) => Object.values(tab.panes)),
    ...workspace.popups.map((popup) => popup.pane),
  ];
}

/**
 * Where a pane lives.
 *
 * One question with two answers — a tab, or the rail — asked in one place so
 * that closing, disposing and moving do not each grow their own version of it.
 * `tabId` is `null` for a pop-up, which is what tells the two apart.
 */
export function locatePane(
  workspace: Workspace,
  paneId: string,
): { pane: PaneState; tabId: string | null } | null {
  for (const tab of workspace.tabs) {
    const pane = tab.panes[paneId];
    if (pane) return { pane, tabId: tab.id };
  }
  const popup = workspace.popups.find((candidate) => candidate.pane.id === paneId);
  return popup ? { pane: popup.pane, tabId: null } : null;
}

export function popupOf(workspace: Workspace, paneId: string): Popup | null {
  return workspace.popups.find((popup) => popup.pane.id === paneId) ?? null;
}

/**
 * Which theme something is actually wearing.
 *
 * The whole of the three-level rule, in one line: the innermost choice that was
 * actually made wins, and `app` — which is the setting, and always has a value
 * — is what the chain ends at. Pass as much as applies: a tab and no pane asks
 * what that tab is wearing, neither asks what the window is.
 */
export function themeOf(
  app: ThemeChoice,
  tab?: Tab | null,
  pane?: PaneState | null,
): ThemeChoice {
  return pane?.theme ?? tab?.theme ?? app;
}

/**
 * What the tab strip shows.
 *
 * A user-set name wins; otherwise the focused pane speaks for the tab, because
 * with several panes open the one you are typing into is the one you are
 * thinking about. A pane count is appended so a split tab is distinguishable
 * from a plain one without opening it.
 */
export function tabLabel(tab: Tab): string {
  if (tab.title) return tab.title;
  const pane = focusedPane(tab);
  const base = pane ? paneLabel(pane) : "Empty";
  const count = countPanes(tab.root);
  return count > 1 ? `${base} +${count - 1}` : base;
}

export function paneLabel(pane: PaneState): string {
  if (pane.title) return pane.title;
  switch (pane.kind) {
    case "notepad":
      // A file-backed pane is named after the file, and marked when the buffer
      // has moved away from it.
      return pane.path ? `${baseName(pane.path)}${pane.dirty ? " •" : ""}` : "Notepad";
    case "browser":
      return hostOf(pane.url) ?? "Browser";
    case "image":
    case "media":
    case "model":
      return baseName(pane.path) || "File";
    case "terminal":
      return "Terminal";
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

export type Action =
  | { type: "restore"; workspace: Workspace }
  | { type: "ui/sidebar"; open?: boolean }
  | { type: "tab/new"; kind: PaneKind }
  | { type: "tab/open"; kind: PaneKind; seed: Partial<PaneState> }
  | { type: "tab/close"; tabId: string }
  | { type: "tab/select"; tabId: string }
  | { type: "tab/step"; delta: number }
  | { type: "tab/selectIndex"; index: number }
  | { type: "tab/reorder"; tabId: string; toIndex: number }
  | { type: "tab/rename"; tabId: string; title: string | undefined }
  /** `undefined` puts the tab back to following the app's theme. */
  | { type: "tab/theme"; tabId: string; theme: ThemeChoice | undefined }
  | {
      type: "tab/graft";
      sourceTabId: string;
      targetTabId: string;
      targetPaneId: string;
      /** Which side of the target pane the tab lands on. Never `center`: a tab
       *  has no single pane to swap with. */
      edge: Exclude<DropEdge, "center">;
    }
  | {
      /** A whole tab moved into one pane's slot, the pane leaving as a tab. */
      type: "tab/absorb";
      sourceTabId: string;
      targetTabId: string;
      targetPaneId: string;
    }
  | {
      type: "pane/split";
      tabId: string;
      paneId: string;
      axis: Axis;
      kind: PaneKind;
      /** Put the new pane above or to the left, rather than after. */
      before?: boolean;
      /** What the new pane starts as — a file's path, a URL. */
      seed?: Partial<PaneState>;
    }
  | {
      /** One pane traded for a different kind of pane, in place. */
      type: "pane/replace";
      paneId: string;
      kind: PaneKind;
      seed?: Partial<PaneState>;
    }
  | { type: "pane/close"; tabId: string; paneId: string }
  /**
   * A pane picked up from wherever it is and put somewhere else.
   *
   * One action for every direction — tab to pop-up, pop-up to tab, tab to tab,
   * beside another pane — because they are one gesture with four destinations,
   * and because the hard part is the same in all four: the pane must keep its
   * id. Everything a pane owns outside React is found by that id, so a "move"
   * that minted a new one would be a close and an open wearing a disguise, and
   * the shell would be gone.
   */
  | { type: "pane/moveTo"; paneId: string; to: MoveTarget }
  /** A pane arriving from another window. See `pane/eject` for the other half. */
  | { type: "pane/adopt"; pane: PaneState; as: "tab" | "popup" }
  /**
   * A pane leaving for another window: removed, but *not* disposed.
   *
   * The distinction is the whole reason this is not `pane/close`. The shell
   * behind it keeps running and the window that adopted it is about to attach
   * to it; killing the pty here would move a corpse.
   */
  | { type: "pane/eject"; paneId: string }
  | { type: "popup/open"; kind: PaneKind; seed?: Partial<PaneState> }
  /** Slide a pop-up along the rail. `x` is a fraction of the pane area. */
  | { type: "popup/move"; paneId: string; x: number }
  | { type: "popup/state"; paneId: string; state: PopupState }
  | { type: "popup/focus"; paneId: string }
  | { type: "popup/close"; paneId: string }
  | { type: "pane/focus"; tabId: string; paneId: string }
  | { type: "pane/focusDirection"; tabId: string; direction: Direction }
  | { type: "pane/move"; tabId: string; paneId: string; targetPaneId: string; edge: DropEdge }
  | { type: "pane/ratio"; tabId: string; nodeId: string; ratio: number }
  | { type: "pane/nudge"; tabId: string; direction: Direction }
  | { type: "pane/zoom"; tabId: string; paneId?: string }
  /** Panes are unique by id across every tab and every pop-up, so neither of
   *  these needs to be told where the pane lives. */
  | { type: "pane/meta"; paneId: string; patch: Partial<PaneState> }
  /** `undefined` puts the pane back to following its tab. */
  | { type: "pane/theme"; paneId: string; theme: ThemeChoice | undefined }
  /** An icon chosen by hand, or `undefined` to go back to working it out. */
  | { type: "pane/profile"; paneId: string; profile: string | undefined }
  /** `undefined` puts the pane back to the font size in the settings. */
  | { type: "pane/fontSize"; paneId: string; fontSize: number | undefined }
  | { type: "tab/profile"; tabId: string; profile: string | undefined }
  /** tmux has described a control session; make the tabs agree with it. */
  | { type: "tmux/sync"; session: string; windows: TmuxWindow[] }
  /** A control session ended or was detached from; its tabs go with it. */
  | { type: "tmux/closed"; session: string };

/** How far one keyboard resize step moves a divider. */
const NUDGE = 0.03;

/**
 * Actions that mean "the keyboard is in a tab now".
 *
 * A pop-up floats over every tab, so nothing about switching tabs or focusing a
 * pane inside one would otherwise take the keyboard away from it — you would
 * click a tab, watch it come forward, and find your typing still going into the
 * pop-up. Listed here rather than handled in each case because the rule is one
 * rule, and a case that forgot it would be a bug nobody would think to look for.
 */
const FOCUSES_A_TAB = new Set<Action["type"]>([
  "tab/new",
  "tab/open",
  "tab/select",
  "tab/step",
  "tab/selectIndex",
  "tab/graft",
  "tab/absorb",
  "pane/focus",
  "pane/focusDirection",
  "pane/split",
  "pane/move",
  "pane/zoom",
]);
// Deliberately not `pane/replace`: it can be aimed at a pane on the rail as
// easily as one in a tab, and changing what a pane *is* is not a statement
// about where the keyboard should be.

export function reduce(state: Workspace, action: Action): Workspace {
  const next = apply(state, action);
  if (!FOCUSES_A_TAB.has(action.type) || next.focusedPopupId === null) return next;
  return { ...next, focusedPopupId: null };
}

function apply(state: Workspace, action: Action): Workspace {
  switch (action.type) {
    case "restore":
      return action.workspace;

    case "ui/sidebar":
      return { ...state, sidebarOpen: action.open ?? !state.sidebarOpen };

    case "tab/new": {
      const tab = newTab(action.kind);
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id };
    }

    // A new tab around something that already exists — a file that was just
    // chosen in the open dialog.
    case "tab/open": {
      const tab = newTab(action.kind, action.seed);
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id };
    }

    case "tab/close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      if (tabs.length === 0) {
        // Closing the last tab opens a fresh one rather than leaving a window
        // with nothing in it and no obvious way forward.
        const replacement = newTab("terminal");
        return { ...state, tabs: [replacement], activeTabId: replacement.id };
      }
      const activeTabId =
        state.activeTabId === action.tabId
          ? // Focus falls to the neighbour on the right, as in every browser.
            tabs[Math.min(index, tabs.length - 1)].id
          : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }

    case "tab/select":
      return { ...state, activeTabId: action.tabId };

    case "tab/step": {
      if (state.tabs.length === 0) return state;
      const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const next = (index + action.delta + state.tabs.length) % state.tabs.length;
      return { ...state, activeTabId: state.tabs[next].id };
    }

    case "tab/selectIndex": {
      const tab = state.tabs[action.index];
      return tab ? { ...state, activeTabId: tab.id } : state;
    }

    case "tab/reorder": {
      const from = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(state.tabs.length - 1, action.toIndex));
      if (from === to) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { ...state, tabs };
    }

    case "tab/rename":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        title: action.title?.trim() ? action.title.trim() : undefined,
      }));

    case "tab/theme":
      return mapTab(state, action.tabId, (tab) =>
        tab.theme === action.theme ? tab : { ...tab, theme: action.theme },
      );

    /**
     * A tab dropped into another tab's workspace.
     *
     * The whole tab arrives, not its panes one by one: the source tab's split
     * tree is grafted in beside the pane it was dropped on, so a tab that was
     * three panes in an L shape is still three panes in an L shape, now filling
     * half of somewhere else. Flattening them into siblings would be easier and
     * would throw away the arrangement the user had already made.
     *
     * The source tab then ceases to exist, which is what makes this a move
     * rather than a copy. Its panes keep their ids, so nothing about the shells
     * behind them changes — see `Workspace` for why that is more than a
     * bookkeeping detail.
     */
    case "tab/graft": {
      // A tab cannot be dropped into itself: the graft would need the tree it
      // is being inserted into as its own subtree.
      if (action.sourceTabId === action.targetTabId) return state;
      const source = state.tabs.find((tab) => tab.id === action.sourceTabId);
      const target = state.tabs.find((tab) => tab.id === action.targetTabId);
      if (!source || !target) return state;
      if (!hasPane(target.root, action.targetPaneId)) return state;

      const axis: Axis = action.edge === "left" || action.edge === "right" ? "x" : "y";
      const before = action.edge === "left" || action.edge === "top";
      const merged: Tab = {
        ...target,
        root: graftTree(target.root, action.targetPaneId, axis, source.root, newId(), before),
        // Pane ids are minted, never reused, so the two maps cannot collide.
        panes: { ...target.panes, ...source.panes },
        // Focus follows what was dragged, which is the thing being looked at.
        focusedPaneId: source.focusedPaneId,
        // Both tabs' zooms are dropped: the drop is a request to see the two
        // sets of panes together, and a zoom is the opposite of that.
        zoomedPaneId: null,
      };

      return {
        ...state,
        tabs: state.tabs
          .filter((tab) => tab.id !== action.sourceTabId)
          .map((tab) => (tab.id === action.targetTabId ? merged : tab)),
        activeTabId: action.targetTabId,
      };
    }

    /**
     * Another tab's panes, moved into one pane's slot.
     *
     * The exchange is deliberately even: the source tab's tree takes the pane's
     * place, and the pane it displaced leaves as a tab of its own, standing
     * where the source tab stood. Nothing is created and nothing is destroyed,
     * so choosing the wrong thing from a menu costs a second trip rather than a
     * shell that was in the middle of something. Every pane keeps its id, which
     * is what stops any of this from reaching the processes behind them.
     */
    case "tab/absorb": {
      // A tab cannot be moved into one of its own panes: the tree would have to
      // contain itself.
      if (action.sourceTabId === action.targetTabId) return state;
      const source = state.tabs.find((tab) => tab.id === action.sourceTabId);
      const target = state.tabs.find((tab) => tab.id === action.targetTabId);
      if (!source || !target) return state;
      const displaced = target.panes[action.targetPaneId];
      if (!displaced || !hasPane(target.root, action.targetPaneId)) return state;

      const merged: Tab = {
        ...target,
        root: substituteTree(target.root, action.targetPaneId, source.root),
        panes: { ...omit(target.panes, action.targetPaneId), ...source.panes },
        focusedPaneId: source.focusedPaneId,
        // The move is a request to see the arrangement it makes, and a zoom is
        // the opposite of that.
        zoomedPaneId: null,
      };
      const evicted: Tab = {
        id: newId(),
        // No theme, because nobody has chosen one for this tab: it is brand
        // new. It was tempting to copy the target tab's, so the pane would
        // leave looking exactly as it did — but that would put a *concrete*
        // theme on a tab the user never themed, and the next change to the app
        // theme would then leave it behind. Default until changed, everywhere.
        root: leaf(newId(), displaced.id),
        panes: { [displaced.id]: displaced },
        focusedPaneId: displaced.id,
        zoomedPaneId: null,
      };

      return {
        ...state,
        // Written in place rather than removed and appended, so the strip does
        // not reshuffle around a change that happened somewhere else.
        tabs: state.tabs.map((tab) =>
          tab.id === action.targetTabId
            ? merged
            : tab.id === action.sourceTabId
              ? evicted
              : tab,
        ),
        activeTabId: action.targetTabId,
      };
    }

    case "pane/split":
      return mapTab(state, action.tabId, (tab) => {
        if (!hasPane(tab.root, action.paneId)) return tab;
        const pane = newPane(action.kind, {
          ...inheritFrom(tab.panes[action.paneId], action.kind),
          ...action.seed,
        });
        return {
          ...tab,
          root: splitInTree(
            tab.root,
            action.paneId,
            action.axis,
            pane.id,
            { split: newId(), leaf: newId() },
            action.before ?? false,
          ),
          panes: { ...tab.panes, [pane.id]: pane },
          focusedPaneId: pane.id,
          // A split is a request to see both halves, so it always unzooms.
          zoomedPaneId: null,
        };
      });

    /**
     * One pane traded for a different kind of pane, in place.
     *
     * The replacement gets a new id rather than inheriting the old one. Ids are
     * how everything outside the reducer finds a pane's belongings — its pty,
     * its scrollback file, its draft text — so reusing one would hand a fresh
     * notepad the previous terminal's log. Releasing those belongings is the
     * caller's job, for the same reason it is in `pane/close`.
     */
    case "pane/replace": {
      const replacement = newPane(action.kind, action.seed);

      // A pop-up is a slot like any other, and what someone means by "make this
      // a notepad" does not change because the pane is floating.
      if (popupOf(state, action.paneId) !== null) {
        return {
          ...mapPopup(state, action.paneId, (popup) => ({ ...popup, pane: replacement })),
          focusedPopupId:
            state.focusedPopupId === action.paneId ? replacement.id : state.focusedPopupId,
        };
      }

      const tab = state.tabs.find((candidate) => candidate.panes[action.paneId] !== undefined);
      if (tab === undefined) return state;
      return mapTab(state, tab.id, (current) => ({
        ...current,
        root: repointPane(current.root, action.paneId, replacement.id),
        panes: { ...omit(current.panes, action.paneId), [replacement.id]: replacement },
        focusedPaneId:
          current.focusedPaneId === action.paneId ? replacement.id : current.focusedPaneId,
        // A zoomed pane that is replaced stays zoomed: the new pane is filling
        // the same slot, and dropping the zoom would be an unasked-for change
        // of layout on top of the one that was asked for.
        zoomedPaneId:
          current.zoomedPaneId === action.paneId ? replacement.id : current.zoomedPaneId,
      }));
    }

    case "pane/close": {
      const tab = state.tabs.find((candidate) => candidate.id === action.tabId);
      if (!tab) return state;
      // The last pane going means the tab is over; routing through tab/close
      // keeps the "never leave an empty window" rule in one place.
      if (countPanes(tab.root) <= 1) {
        return apply(state, { type: "tab/close", tabId: action.tabId });
      }
      return mapTab(state, action.tabId, (current) => {
        const before = layout(current.root).panes;
        const root = removePane(current.root, action.paneId);
        if (root === null) return current;
        const panes = { ...current.panes };
        delete panes[action.paneId];
        // Focus lands on whatever was next to the pane that closed, so the eye
        // does not have to go looking for it.
        const fallback =
          neighbor(before, action.paneId, "right") ??
          neighbor(before, action.paneId, "left") ??
          neighbor(before, action.paneId, "down") ??
          neighbor(before, action.paneId, "up") ??
          paneIds(root)[0];
        return {
          ...current,
          root,
          panes,
          focusedPaneId:
            current.focusedPaneId === action.paneId ? fallback : current.focusedPaneId,
          zoomedPaneId:
            current.zoomedPaneId === action.paneId ? null : current.zoomedPaneId,
        };
      });
    }

    /**
     * A pane picked up and put down somewhere else, keeping its id.
     *
     * Ordered so that a pane can never be lost: the destination is asked to
     * accept it *after* it has been taken out, and if it will not — a tab that
     * has since gone, a target pane that is the one being moved — the whole
     * action is dropped and the state before it stands. There is no partial
     * outcome where a shell has left one place and arrived nowhere.
     */
    case "pane/moveTo": {
      const taken = detachPane(state, action.paneId);
      if (taken === null) return state;
      return insertPane(taken.state, taken.pane, action.to) ?? state;
    }

    case "pane/adopt":
      return (
        insertPane(state, action.pane, action.as === "popup" ? { kind: "popup" } : { kind: "newTab" }) ??
        state
      );

    case "pane/eject":
      return detachPane(state, action.paneId)?.state ?? state;

    case "popup/open": {
      const pane = newPane(action.kind, action.seed);
      return {
        ...state,
        popups: [...state.popups, newPopup(pane, state.popups.length)],
        focusedPopupId: pane.id,
      };
    }

    case "popup/move":
      return mapPopup(state, action.paneId, (popup) => ({
        ...popup,
        // Clamped against the popup's own width so it cannot be pushed off the
        // end of the rail and out of reach.
        x: Math.max(0, Math.min(1 - popup.width, action.x)),
      }));

    case "popup/state": {
      const next = mapPopup(state, action.paneId, (popup) =>
        popup.state === action.state ? popup : { ...popup, state: action.state },
      );
      // Minimising is a way of putting something down, so the keyboard goes
      // back to the tab underneath; the other two are a way of picking it up.
      return action.state === "minimized"
        ? {
            ...next,
            focusedPopupId: next.focusedPopupId === action.paneId ? null : next.focusedPopupId,
          }
        : raisePopup({ ...next, focusedPopupId: action.paneId }, action.paneId);
    }

    case "popup/focus":
      return state.focusedPopupId === action.paneId &&
        state.popups[state.popups.length - 1]?.pane.id === action.paneId
        ? state
        : raisePopup({ ...state, focusedPopupId: action.paneId }, action.paneId);

    case "popup/close":
      return {
        ...state,
        popups: state.popups.filter((popup) => popup.pane.id !== action.paneId),
        focusedPopupId: state.focusedPopupId === action.paneId ? null : state.focusedPopupId,
      };

    case "pane/focus":
      return mapTab(state, action.tabId, (tab) =>
        hasPane(tab.root, action.paneId) ? { ...tab, focusedPaneId: action.paneId } : tab,
      );

    case "pane/focusDirection":
      return mapTab(state, action.tabId, (tab) => {
        // Directional movement inside a zoomed pane would jump to something
        // that is not on screen, so it unzooms instead.
        const panes = layout(tab.root).panes;
        const next = neighbor(panes, tab.focusedPaneId, action.direction);
        if (next === null) return tab;
        return { ...tab, focusedPaneId: next, zoomedPaneId: null };
      });

    case "pane/move":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        root: moveInTree(tab.root, action.paneId, action.targetPaneId, action.edge, {
          split: newId(),
          leaf: newId(),
        }),
        focusedPaneId: action.paneId,
        zoomedPaneId: null,
      }));

    case "pane/ratio":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        root: setRatioInTree(tab.root, action.nodeId, action.ratio),
      }));

    case "pane/nudge":
      return mapTab(state, action.tabId, (tab) => {
        const target = resizeTarget(tab.root, tab.focusedPaneId, action.direction);
        if (target === null) return tab;
        const current = findRatio(tab.root, target.nodeId);
        if (current === null) return tab;
        return {
          ...tab,
          root: setRatioInTree(
            tab.root,
            target.nodeId,
            clampRatio(current + target.delta * NUDGE),
          ),
        };
      });

    case "pane/zoom":
      return mapTab(state, action.tabId, (tab) => {
        const paneId = action.paneId ?? tab.focusedPaneId;
        if (countPanes(tab.root) <= 1) return tab;
        return {
          ...tab,
          zoomedPaneId: tab.zoomedPaneId === paneId ? null : paneId,
          focusedPaneId: paneId,
        };
      });

    case "pane/meta":
      return mapPane(state, action.paneId, (pane) => {
        const next = { ...pane, ...action.patch } as PaneState;
        return shallowEqual(pane, next) ? pane : next;
      });

    case "pane/theme":
      return mapPane(state, action.paneId, (pane) =>
        pane.theme === action.theme ? pane : { ...pane, theme: action.theme },
      );

    case "pane/profile":
      return mapPane(state, action.paneId, (pane) =>
        pane.profile === action.profile ? pane : { ...pane, profile: action.profile },
      );

    case "pane/fontSize":
      return mapPane(state, action.paneId, (pane) =>
        pane.fontSize === action.fontSize ? pane : { ...pane, fontSize: action.fontSize },
      );

    case "tab/profile":
      return mapTab(state, action.tabId, (tab) =>
        tab.profile === action.profile ? tab : { ...tab, profile: action.profile },
      );

    /**
     * Make the tabs of one control session say what tmux says.
     *
     * Wholesale for the windows named, rather than a diff: tmux has just
     * described its own state and there is nothing here worth preserving
     * against it. What *is* preserved is identity — tab ids and pane ids are
     * derived from tmux's, so a window that was already open keeps its position
     * in the strip and its terminals keep running. Only the tree is replaced.
     *
     * Windows this session no longer has lose their tabs. Windows of *other*
     * sessions, and every ordinary tab, are left alone: one session's news says
     * nothing about anyone else.
     */
    case "tmux/sync": {
      const wanted = new Map(
        action.windows.map((window) => [windowTabId(action.session, window.id), window]),
      );

      const kept = state.tabs.filter(
        (tab) => !belongsTo(tab, action.session) || wanted.has(tab.id),
      );

      const tabs = kept.map((tab) => {
        const window = wanted.get(tab.id);
        if (!window) return tab;
        wanted.delete(tab.id);
        return syncTab(tab, action.session, window);
      });

      // Whatever is left is new, and joins the strip in tmux's order.
      for (const [tabId, window] of wanted) {
        tabs.push(syncTab(blankTab(tabId), action.session, window));
      }

      const activeTabId =
        state.activeTabId !== null && tabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : (tabs[tabs.length - 1]?.id ?? null);

      return { ...state, tabs, activeTabId };
    }

    /**
     * The session is gone — detached, killed, or the client died.
     *
     * The tabs go without disposing their panes. A control pane's `dispose`
     * kills tmux's pane, and detaching from a session must not be a way to
     * destroy the work in it.
     */
    case "tmux/closed": {
      const tabs = state.tabs.filter((tab) => !belongsTo(tab, action.session));
      // A control pane someone moved onto the rail belongs to the session just
      // as much as one still in a tab, and goes with it.
      const popups = state.popups.filter((popup) => !isControlPane(popup.pane, action.session));
      if (tabs.length === state.tabs.length && popups.length === state.popups.length) return state;
      const activeTabId =
        state.activeTabId !== null && tabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : (tabs[0]?.id ?? null);
      return {
        ...state,
        tabs,
        activeTabId,
        popups,
        focusedPopupId: popups.some((popup) => popup.pane.id === state.focusedPopupId)
          ? state.focusedPopupId
          : null,
      };
    }
  }
}

/** Whether a tab is one of `session`'s control-mode windows. */
function belongsTo(tab: Tab, session: string): boolean {
  return Object.values(tab.panes).some((pane) => isControlPane(pane, session));
}

/** A pane tmux is running and jterm is only drawing. */
function isControlPane(pane: PaneState, session: string): boolean {
  return pane.kind === "terminal" && pane.tmuxPane !== undefined && pane.tmux === session;
}

function blankTab(id: string): Tab {
  return { id, root: leaf(`${id}-root`, ""), panes: {}, focusedPaneId: "", zoomedPaneId: null };
}

/**
 * One tab, made to match one tmux window.
 *
 * The focused pane is kept if tmux still has it — moving between panes inside
 * tmux and having jterm forget where you were would make the focus jump on
 * every split — and otherwise falls to whichever pane tmux lists first.
 */
function syncTab(tab: Tab, session: string, window: TmuxWindow): Tab {
  const panes = panesFor(session, window.layout);
  const root = toNode(window.layout, windowTabId(session, window.id));
  const ids = Object.keys(panes);
  const focusedPaneId = panes[tab.focusedPaneId] ? tab.focusedPaneId : (ids[0] ?? "");

  return {
    ...tab,
    // tmux's window name, unless the user has renamed the tab here.
    title: tab.title ?? (window.name || undefined),
    root,
    panes,
    focusedPaneId,
    // A pane zoomed in jterm that tmux no longer has is not zoomed any more.
    zoomedPaneId: tab.zoomedPaneId && panes[tab.zoomedPaneId] ? tab.zoomedPaneId : null,
  };
}

/**
 * What a new pane should carry over from the one it was split off.
 *
 * Only the working directory, and only between terminals: splitting a terminal
 * is nearly always "another shell, here", and having to `cd` back to where you
 * already were is the small friction that makes people stop using splits.
 *
 * Notably *not* the tmux session. Two panes attached to one session are two
 * views of the same shell, each fighting the other over how wide it is — so a
 * split gets a session of its own, which the new pane works out for itself from
 * the setting.
 *
 * Nor the theme, and here "nor" means *nothing is copied*, not "it comes out
 * looking different". A new pane is default-themed, and default is not a
 * colour — it is a live reference to the level above, so the pane wears its
 * tab's theme and keeps wearing it when the tab's changes. In the ordinary case
 * — a tab nobody has themed individually — that is exactly the pane it was
 * split off, which is what you would expect from a split.
 *
 * What is deliberately *not* carried over is an override the source pane had of
 * its own. Those exist to tell one pane apart from the one beside it — this
 * shell is on production, that one is not — and a split that duplicated the
 * override would undo the distinction at the exact moment it is being drawn.
 */
function inheritFrom(source: PaneState | undefined, kind: PaneKind): Partial<PaneState> {
  if (kind === "terminal" && source?.kind === "terminal" && source.cwd) {
    return { cwd: source.cwd } as Partial<PaneState>;
  }
  return {};
}

function omit(panes: Record<string, PaneState>, paneId: string): Record<string, PaneState> {
  const next = { ...panes };
  delete next[paneId];
  return next;
}

/**
 * Take a pane out of wherever it is, and hand it back.
 *
 * The counterpart of `insertPane`, and deliberately not "close": nothing is
 * disposed here, because every caller is moving the pane rather than ending
 * it. A tab left with no panes goes too, through `tab/close` so that the rule
 * about never leaving an empty window stays in one place.
 */
function detachPane(
  state: Workspace,
  paneId: string,
): { state: Workspace; pane: PaneState } | null {
  const popup = popupOf(state, paneId);
  if (popup !== null) {
    return {
      pane: popup.pane,
      state: {
        ...state,
        popups: state.popups.filter((candidate) => candidate.pane.id !== paneId),
        focusedPopupId: state.focusedPopupId === paneId ? null : state.focusedPopupId,
      },
    };
  }

  const tab = state.tabs.find((candidate) => candidate.panes[paneId] !== undefined);
  if (tab === undefined) return null;
  const pane = tab.panes[paneId];

  if (countPanes(tab.root) <= 1) {
    return { pane, state: apply(state, { type: "tab/close", tabId: tab.id }) };
  }

  const before = layout(tab.root).panes;
  const root = removePane(tab.root, paneId);
  if (root === null) return null;
  // Focus lands next door, exactly as it does when a pane is closed: the pane
  // has left the tab either way, and the eye should not have to go looking.
  const fallback =
    neighbor(before, paneId, "right") ??
    neighbor(before, paneId, "left") ??
    neighbor(before, paneId, "down") ??
    neighbor(before, paneId, "up") ??
    paneIds(root)[0];

  return {
    pane,
    state: mapTab(state, tab.id, (current) => ({
      ...current,
      root,
      panes: omit(current.panes, paneId),
      focusedPaneId: current.focusedPaneId === paneId ? fallback : current.focusedPaneId,
      zoomedPaneId: current.zoomedPaneId === paneId ? null : current.zoomedPaneId,
    })),
  };
}

/**
 * Put a pane somewhere, or refuse.
 *
 * `null` means the destination could not take it — a tab that no longer
 * exists, or a pane asked to be split against itself. Refusing rather than
 * improvising is what lets `pane/moveTo` treat a failed insert as "nothing
 * happened at all": the caller still holds the state from before the pane was
 * taken out, and simply keeps it.
 */
function insertPane(state: Workspace, pane: PaneState, to: MoveTarget): Workspace | null {
  switch (to.kind) {
    case "popup":
      return {
        ...state,
        popups: [...state.popups, newPopup(pane, state.popups.length)],
        focusedPopupId: pane.id,
      };

    case "newTab": {
      const tab: Tab = {
        id: newId(),
        root: leaf(newId(), pane.id),
        panes: { [pane.id]: pane },
        focusedPaneId: pane.id,
        zoomedPaneId: null,
      };
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id, focusedPopupId: null };
    }

    case "tab": {
      const target = state.tabs.find((candidate) => candidate.id === to.tabId);
      if (target === undefined) return null;
      return besidePane(state, pane, target.id, target.focusedPaneId, "x", false);
    }

    case "split": {
      if (to.paneId === pane.id) return null;
      const target = state.tabs.find((candidate) => candidate.panes[to.paneId] !== undefined);
      if (target === undefined) return null;
      return besidePane(state, pane, target.id, to.paneId, to.axis ?? "x", to.before ?? false);
    }
  }
}

/** One pane grafted in beside another, and focused where it landed. */
function besidePane(
  state: Workspace,
  pane: PaneState,
  tabId: string,
  targetPaneId: string,
  axis: Axis,
  before: boolean,
): Workspace | null {
  const target = state.tabs.find((candidate) => candidate.id === tabId);
  if (target === undefined || !hasPane(target.root, targetPaneId)) return null;

  return {
    ...mapTab(state, tabId, (tab) => ({
      ...tab,
      root: splitInTree(tab.root, targetPaneId, axis, pane.id, {
        split: newId(),
        leaf: newId(),
      }, before),
      panes: { ...tab.panes, [pane.id]: pane },
      focusedPaneId: pane.id,
      // Arriving is a request to see the pane, and a zoomed sibling is the
      // one thing that would hide it.
      zoomedPaneId: null,
    })),
    activeTabId: tabId,
    focusedPopupId: null,
  };
}

function mapPopup(state: Workspace, paneId: string, change: (popup: Popup) => Popup): Workspace {
  let touched = false;
  const popups = state.popups.map((popup) => {
    if (popup.pane.id !== paneId) return popup;
    const next = change(popup);
    if (next !== popup) touched = true;
    return next;
  });
  return touched ? { ...state, popups } : state;
}

/** Bring one pop-up to the front, which here means to the end of the array. */
function raisePopup(state: Workspace, paneId: string): Workspace {
  const popup = popupOf(state, paneId);
  if (popup === null) return state;
  return {
    ...state,
    popups: [...state.popups.filter((candidate) => candidate !== popup), popup],
  };
}

/** One pane changed wherever it lives — in a tab, or on the rail. */
function mapPane(
  state: Workspace,
  paneId: string,
  change: (pane: PaneState) => PaneState,
): Workspace {
  const popup = popupOf(state, paneId);
  if (popup !== null) {
    const next = change(popup.pane);
    return next === popup.pane ? state : mapPopup(state, paneId, (p) => ({ ...p, pane: next }));
  }

  const tab = state.tabs.find((candidate) => candidate.panes[paneId] !== undefined);
  if (tab === undefined) return state;
  return mapTab(state, tab.id, (current) => {
    const pane = current.panes[paneId];
    const next = change(pane);
    return next === pane ? current : { ...current, panes: { ...current.panes, [paneId]: next } };
  });
}

function mapTab(state: Workspace, tabId: string, change: (tab: Tab) => Tab): Workspace {
  let touched = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    const next = change(tab);
    if (next !== tab) touched = true;
    return next;
  });
  return touched ? { ...state, tabs } : state;
}

function findRatio(node: Node, nodeId: string): number | null {
  if (node.kind === "leaf") return null;
  if (node.id === nodeId) return node.ratio;
  return findRatio(node.children[0], nodeId) ?? findRatio(node.children[1], nodeId);
}

function shallowEqual(a: object, b: object): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

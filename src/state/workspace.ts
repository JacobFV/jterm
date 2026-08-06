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

import { newId } from "@/lib/utils";
import {
  type Axis,
  type DropEdge,
  type Direction,
  type Node,
  clampRatio,
  countPanes,
  hasPane,
  layout,
  leaf,
  movePane as moveInTree,
  neighbor,
  paneIds,
  removePane,
  resizeTarget,
  setRatio as setRatioInTree,
  splitPane as splitInTree,
} from "./tree";

export type PaneKind = "terminal" | "notepad" | "browser" | "image" | "media" | "model";

interface PaneCommon {
  id: string;
  /** Set by the pane itself — a shell's title, a page's title, a file name. */
  title?: string;
}

export interface TerminalPaneState extends PaneCommon {
  kind: "terminal";
  /** Last known working directory, so a restored tab reopens where it was. */
  cwd?: string;
  /** True once the shell has exited and the pane is only showing its remains. */
  exited?: boolean;
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
  root: Node;
  panes: Record<string, PaneState>;
  focusedPaneId: string;
  /** The pane temporarily filling the tab, tmux's `prefix z`. */
  zoomedPaneId: string | null;
}

export interface Workspace {
  tabs: Tab[];
  activeTabId: string | null;
  /** Whether the file tree is showing. Persisted: a sidebar that closes itself
   *  on every launch is one the user has to reopen on every launch. */
  sidebarOpen: boolean;
}

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
  return { tabs: [tab], activeTabId: tab.id, sidebarOpen: false };
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export function activeTab(workspace: Workspace): Tab | null {
  return workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
}

export function focusedPane(tab: Tab): PaneState | null {
  return tab.panes[tab.focusedPaneId] ?? null;
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
  | { type: "pane/split"; tabId: string; paneId: string; axis: Axis; kind: PaneKind }
  | { type: "pane/close"; tabId: string; paneId: string }
  | { type: "pane/focus"; tabId: string; paneId: string }
  | { type: "pane/focusDirection"; tabId: string; direction: Direction }
  | { type: "pane/move"; tabId: string; paneId: string; targetPaneId: string; edge: DropEdge }
  | { type: "pane/ratio"; tabId: string; nodeId: string; ratio: number }
  | { type: "pane/nudge"; tabId: string; direction: Direction }
  | { type: "pane/zoom"; tabId: string; paneId?: string }
  | { type: "pane/meta"; tabId: string; paneId: string; patch: Partial<PaneState> };

/** How far one keyboard resize step moves a divider. */
const NUDGE = 0.03;

export function reduce(state: Workspace, action: Action): Workspace {
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

    case "pane/split":
      return mapTab(state, action.tabId, (tab) => {
        if (!hasPane(tab.root, action.paneId)) return tab;
        const pane = newPane(action.kind, inheritFrom(tab.panes[action.paneId], action.kind));
        return {
          ...tab,
          root: splitInTree(tab.root, action.paneId, action.axis, pane.id, {
            split: newId(),
            leaf: newId(),
          }),
          panes: { ...tab.panes, [pane.id]: pane },
          focusedPaneId: pane.id,
          // A split is a request to see both halves, so it always unzooms.
          zoomedPaneId: null,
        };
      });

    case "pane/close": {
      const tab = state.tabs.find((candidate) => candidate.id === action.tabId);
      if (!tab) return state;
      // The last pane going means the tab is over; routing through tab/close
      // keeps the "never leave an empty window" rule in one place.
      if (countPanes(tab.root) <= 1) {
        return reduce(state, { type: "tab/close", tabId: action.tabId });
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
      return mapTab(state, action.tabId, (tab) => {
        const pane = tab.panes[action.paneId];
        if (!pane) return tab;
        const next = { ...pane, ...action.patch } as PaneState;
        if (shallowEqual(pane, next)) return tab;
        return { ...tab, panes: { ...tab.panes, [action.paneId]: next } };
      });
  }
}

/**
 * What a new pane should carry over from the one it was split off.
 *
 * Only the working directory, and only between terminals: splitting a terminal
 * is nearly always "another shell, here", and having to `cd` back to where you
 * already were is the small friction that makes people stop using splits.
 */
function inheritFrom(source: PaneState | undefined, kind: PaneKind): Partial<PaneState> {
  if (kind === "terminal" && source?.kind === "terminal" && source.cwd) {
    return { cwd: source.cwd } as Partial<PaneState>;
  }
  return {};
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

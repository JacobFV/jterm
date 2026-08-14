/**
 * The window: a tab strip that doubles as the titlebar, and every tab's panes
 * stacked underneath it.
 *
 * Two things here are worth knowing before changing anything:
 *
 *   - **Nothing renders until the snapshot has been read.** Panes create real
 *     resources on mount — a shell, a webview — so rendering a default
 *     workspace first and replacing it a moment later would spawn processes
 *     only to abandon them. `loaded` gates the whole tree.
 *   - **Every tab stays mounted.** Switching tabs changes `visibility`, not
 *     what exists. A backgrounded shell keeps running, keeps its scrollback,
 *     and keeps its size — see `PaneGrid` for why the size in particular
 *     matters.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { AmbientBackdrop } from "@/components/shell/AmbientBackdrop";
import { FileTree } from "@/components/shell/FileTree";
import type { PaneMenuActions } from "@/components/shell/PaneMenu";
import { ResizeHandles } from "@/components/shell/ResizeHandles";
import { TabStrip } from "@/components/shell/TabStrip";
import { TmuxSessions } from "@/components/shell/TmuxSessions";
import { WindowFrame } from "@/components/shell/WindowFrame";
import {
  Workspace as PaneWorkspace,
  type TabDrag,
  type TabDropTarget,
} from "@/components/shell/Workspace";
import { readClipboard, writeClipboard } from "@/lib/clipboard";
import {
  SESSION_IMPORTED_EVENT,
  TMUX_CLOSED_EVENT,
  TMUX_WINDOWS_EVENT,
  dialog,
  fs,
  history as historyApi,
  listen,
  scrollback as scrollbackApi,
  session,
  tmuxControl,
} from "@/lib/ipc";
import { kindForPath } from "@/lib/filetypes";
import { resolve, type ActionId } from "@/lib/keymap";
import {
  configurePersistence,
  flushPersistence,
  installFlushTriggers,
  markDirty,
} from "@/lib/persist";
import { openSettingsWindow } from "@/lib/settingsWindow";
import { isTauri } from "@/lib/tauri";
import { terminalHandle } from "@/lib/terminals";
import { isTmuxAction, runControlAction, runTmuxAction, tmuxAvailable } from "@/lib/tmux";
import type { TmuxSessionShape } from "@/lib/tmuxControl";
import { useSettings } from "@/lib/useSettings";
import { disposePane } from "@/panes/registry";
import { loadContent, onContentChange, snapshotContent } from "@/state/content";
import { decode, encode } from "@/state/snapshot";
import { getSettings, zoomText, type FileOpenTarget } from "@/state/settings";
import { type Direction, splitPlacement } from "@/state/tree";
import {
  type PaneKind,
  type PaneState,
  type Workspace,
  activeTab,
  emptyWorkspace,
  paneLabel,
  reduce,
} from "@/state/workspace";

function livePaneIds(workspace: Workspace): string[] {
  return workspace.tabs.flatMap((tab) => Object.keys(tab.panes));
}

export function App() {
  const initialRef = useRef<Workspace>(emptyWorkspace());
  const [workspace, dispatch] = useReducer(reduce, initialRef.current);
  const [loaded, setLoaded] = useState(false);
  const [sidebarRoot, setSidebarRoot] = useState<string | null>(null);
  const settings = useSettings();

  // Whether this machine has tmux at all, which is what decides if the feature
  // is offered rather than merely failing when reached. Asked once; the answer
  // cannot usefully change while the window is open.
  const [hasTmux, setHasTmux] = useState(false);
  const [pickingSession, setPickingSession] = useState(false);
  useEffect(() => {
    void tmuxAvailable().then(setHasTmux);
  }, []);

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  /* ── Restore ──────────────────────────────────────────────────────── */

  useEffect(() => {
    void (async () => {
      const snapshot = decode(await session.load());
      if (snapshot) {
        // Contents are loaded before the workspace, so the panes about to mount
        // find their draft and their text already in place.
        loadContent(snapshot.content);
        dispatch({ type: "restore", workspace: snapshot.workspace });
      }
      const live = livePaneIds(snapshot?.workspace ?? initialRef.current);
      // Anything on disk or in the window belonging to a pane that no longer
      // exists is from a session that ended badly. Nothing else will clean it.
      //
      // Control-mode panes are exempt: their tabs are rebuilt from tmux a
      // moment from now, and pruning on the strength of a snapshot that
      // deliberately does not mention them would delete the logs of panes that
      // are about to come back.
      void scrollbackApi.prune(live);
      void historyApi.prune(live);
      setLoaded(true);
      if (snapshot) reattachRef.current(snapshot.controlSessions);
    })();
  }, []);

  /**
   * A session imported from the settings window.
   *
   * The import itself happens over there — it is a file operation, and that is
   * where the file controls are. But the workspace it replaces lives here, so
   * the settings window announces the restored snapshot rather than trying to
   * apply it, and this is the window that acts on it.
   */
  useEffect(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    void listen<string>(SESSION_IMPORTED_EVENT, (snapshot) => {
      const restored = decode(snapshot);
      if (!restored) return;
      loadContent(restored.content);
      dispatch({ type: "restore", workspace: restored.workspace });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  /* ── Control-mode sessions ────────────────────────────────────────── */

  /**
   * tmux describing itself, turned into tabs.
   *
   * The whole of control mode's structure arrives here. tmux is the authority
   * on which windows exist and how their panes are arranged, so this listens
   * rather than asks, and the reducer replaces those tabs' trees outright. Tab
   * and pane ids are derived from tmux's own, which is what keeps a layout
   * change from remounting the terminals inside it — see `lib/tmuxControl.ts`.
   */
  useEffect(() => {
    const stops: (() => void)[] = [];
    let disposed = false;
    const keep = (unlisten: () => void) => {
      if (disposed) unlisten();
      else stops.push(unlisten);
    };

    void listen<TmuxSessionShape>(TMUX_WINDOWS_EVENT, (shape) => {
      dispatch({ type: "tmux/sync", session: shape.session, windows: shape.windows });
    }).then(keep);

    // Detached, killed, or the client died — all the same from here, and none
    // of them are a reason to end anything inside the session.
    void listen<string>(TMUX_CLOSED_EVENT, (name) => {
      dispatch({ type: "tmux/closed", session: name });
    }).then(keep);

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, []);

  /**
   * Reattach to whatever was attached when the app last closed.
   *
   * Control-mode tabs are not in the snapshot — see `state/snapshot.ts` — so
   * this is what brings them back, and it brings them back from tmux rather
   * than from a recording of tmux. A session that has since gone away simply
   * yields no windows and no tabs.
   *
   * The size is a guess until the first pane has measured itself, at which
   * point the real one follows within a frame. Attaching cannot wait for a pane
   * that does not exist until attaching has happened.
   */
  const reattach = useCallback((sessions: string[]) => {
    for (const name of sessions) {
      void tmuxControl.attach(name, 80, 24);
    }
  }, []);
  // Read through a ref by the restore effect, which runs once on mount and must
  // not be rebuilt — or re-run — when this callback is.
  const reattachRef = useRef(reattach);
  reattachRef.current = reattach;

  /* ── Persistence ──────────────────────────────────────────────────── */

  useEffect(() => {
    configurePersistence(() => {
      const current = workspaceRef.current;
      return encode(current, snapshotContent(livePaneIds(current)));
    });
    const stopContent = onContentChange(markDirty);
    const stopTriggers = installFlushTriggers();
    return () => {
      stopContent();
      stopTriggers();
    };
  }, []);

  // Structural changes are worth saving too, but only once the restored
  // workspace is the one in hand — saving before then would overwrite the file
  // being restored from with an empty default.
  useEffect(() => {
    if (loaded) markDirty();
  }, [workspace, loaded]);

  /* ── The file tree's root ─────────────────────────────────────────── */

  // Whatever directory the focused terminal is in. A notepad or a browser has
  // no opinion, so the tree simply stays where it was rather than jumping to
  // home every time focus crosses a pane that is not a shell.
  const focusedCwd = (() => {
    const tab = activeTab(workspace);
    const pane = tab ? tab.panes[tab.focusedPaneId] : null;
    return pane?.kind === "terminal" ? pane.cwd : undefined;
  })();

  // Tracked separately from `sidebarRoot` so that walking up the tree by hand
  // is not undone on the next render — the root only follows the shell when
  // the shell has actually moved.
  const syncedCwd = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focusedCwd && focusedCwd !== syncedCwd.current) {
      syncedCwd.current = focusedCwd;
      setSidebarRoot(focusedCwd);
    }
  }, [focusedCwd]);

  useEffect(() => {
    if (!workspace.sidebarOpen || sidebarRoot !== null) return;
    void fs.home().then((home) => setSidebarRoot((current) => current ?? home));
  }, [workspace.sidebarOpen, sidebarRoot]);

  /* ── Opening a file ───────────────────────────────────────────────── */

  /**
   * Open a file in whichever pane suits it, wherever the user asked files to go.
   *
   * Two decisions, kept apart. *What* opens it is the extension's business, in
   * `kindForPath`, so "what opens a `.stl`" is answered in one place for every
   * route a file can arrive by. *Where* it opens is the user's, in settings: a
   * tab of its own, or a split beside whatever is focused, on the side they
   * chose. `target` overrides that for the one caller that means something
   * specific — the tab strip's `Open file…`, which says "tab" on the label.
   *
   * Settings are read at the moment of the click rather than closed over, so
   * this callback survives a preference change without being rebuilt.
   */
  const openPath = useCallback((path: string, target?: FileOpenTarget) => {
    const settings = getSettings();
    const kind = kindForPath(path);
    const seed = { path } as Partial<PaneState>;
    const tab = activeTab(workspaceRef.current);

    if ((target ?? settings.openFilesIn) === "pane" && tab) {
      const { axis, before } = splitPlacement(settings.openPaneDirection);
      dispatch({
        type: "pane/split",
        tabId: tab.id,
        paneId: tab.focusedPaneId,
        axis,
        before,
        kind,
        seed,
      });
      return;
    }
    dispatch({ type: "tab/open", kind, seed });
  }, []);

  const openFile = useCallback(
    async (target?: FileOpenTarget) => {
      const path = await dialog.open();
      if (path) openPath(path, target);
    },
    [openPath],
  );

  /* ── Closing things ───────────────────────────────────────────────── */

  /**
   * Ask before discarding an unsaved buffer.
   *
   * A scratch note counts: its text lives only in the session snapshot, and
   * closing the pane is what removes it from there. Everything else — a shell,
   * a page, a picture — can be reopened, so nothing is asked about those.
   */
  const confirmDiscard = useCallback(async (panes: PaneState[]): Promise<boolean> => {
    const unsaved = panes.filter((pane) => pane.kind === "notepad" && pane.dirty);
    if (unsaved.length === 0) return true;
    const names = unsaved.map((pane) => paneLabel(pane)).join(", ");
    return dialog.confirmDiscard(names);
  }, []);

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = workspaceRef.current.tabs.find((candidate) => candidate.id === tabId);
      if (tab && !(await confirmDiscard(Object.values(tab.panes)))) return;
      // Disposal happens here rather than in the reducer: killing a shell is not
      // something a pure function should be doing, and a reducer that did it
      // could not be run twice safely.
      if (tab) for (const pane of Object.values(tab.panes)) disposePane(pane);
      dispatch({ type: "tab/close", tabId });
    },
    [confirmDiscard],
  );

  const closePane = useCallback(
    async (tabId: string, paneId: string) => {
      const tab = workspaceRef.current.tabs.find((candidate) => candidate.id === tabId);
      const pane = tab?.panes[paneId];
      if (!pane) return;
      if (!(await confirmDiscard([pane]))) return;
      disposePane(pane);
      dispatch({ type: "pane/close", tabId, paneId });
    },
    [confirmDiscard],
  );

  /* ── Changing what a pane is ──────────────────────────────────────── */

  /**
   * Swap a pane for a different kind of pane, in place.
   *
   * A replacement is a close and an open at once, so it owes the same duties as
   * closing: ask before an unsaved buffer goes, and hand back the shell, the
   * scrollback file and the draft that the pane owned. The reducer mints a new
   * id for the pane that arrives, which is what makes disposing of the old one
   * safe to do first.
   */
  const replacePane = useCallback(
    async (tabId: string, paneId: string, kind: PaneKind, seed?: Partial<PaneState>) => {
      const tab = workspaceRef.current.tabs.find((candidate) => candidate.id === tabId);
      const pane = tab?.panes[paneId];
      if (!pane) return;
      // Picking the kind a pane already is means "leave it alone", not "start
      // it again". The menu lists every kind including the current one, and a
      // shell that is halfway through something is far too expensive to lose to
      // a slip of the mouse. A file always goes through, since choosing one is
      // a request for that file.
      if (pane.kind === kind && seed === undefined) return;
      if (!(await confirmDiscard([pane]))) return;
      disposePane(pane);
      dispatch({ type: "pane/replace", tabId, paneId, kind, seed });
    },
    [confirmDiscard],
  );

  const paneMenu = useMemo<PaneMenuActions>(
    () => ({
      onReplace: (tabId, paneId, kind) => void replacePane(tabId, paneId, kind),
      onReplaceWithFile: (tabId, paneId) =>
        void dialog.open().then((path) => {
          if (path) {
            void replacePane(tabId, paneId, kindForPath(path), { path } as Partial<PaneState>);
          }
        }),
      // Nothing is destroyed by this one, so it needs no confirmation and no
      // disposal — see `tab/absorb`.
      onAbsorbTab: (tabId, paneId, sourceTabId) =>
        dispatch({
          type: "tab/absorb",
          sourceTabId,
          targetTabId: tabId,
          targetPaneId: paneId,
        }),
    }),
    [replacePane],
  );

  /* ── Dragging a tab into the workspace ────────────────────────────── */

  /**
   * A tab dragged below the strip becomes a split.
   *
   * The work is split three ways because no one part knows enough on its own:
   * the strip owns the pointer, the workspace owns the pane rectangles and so
   * is the only thing that can say *where* a drop would land, and only this
   * component can dispatch. So the strip reports where the pointer is, the
   * workspace reports back what that means, and the release turns the latest
   * answer into an action.
   */
  const [tabDrag, setTabDrag] = useState<TabDrag | null>(null);
  const tabDropRef = useRef<TabDropTarget | null>(null);

  const noteTabDropTarget = useCallback((target: TabDropTarget | null) => {
    tabDropRef.current = target;
  }, []);

  const dropTabInWorkspace = useCallback((sourceTabId: string): boolean => {
    const target = tabDropRef.current;
    // Released over nothing in particular — the sidebar, the gap, its own
    // workspace. The tab stays a tab.
    if (target === null) return false;
    dispatch({
      type: "tab/graft",
      sourceTabId,
      targetTabId: target.tabId,
      targetPaneId: target.paneId,
      edge: target.edge,
    });
    return true;
  }, []);

  /* ── Closing the window ───────────────────────────────────────────── */

  /**
   * Ask before the window takes unsaved buffers with it.
   *
   * Terminals and viewers are not asked about: a shell can be started again and
   * a file reopened. A notepad that has never been saved exists only in the
   * session snapshot, and closing the window is the one moment where the user
   * plainly means to stop — so it is the one moment worth interrupting.
   *
   * The snapshot is flushed either way. Answering "close anyway" should still
   * leave everything recoverable on the next launch; the prompt is about the
   * *file* the buffer was never written to, not about losing the text.
   */
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const stop = await win.onCloseRequested(async (event) => {
        const unsaved = workspaceRef.current.tabs.flatMap((tab) =>
          Object.values(tab.panes).filter((pane) => pane.kind === "notepad" && pane.dirty),
        );
        if (unsaved.length === 0) return;

        // Held open while the question is asked; without this the window is
        // already gone by the time the answer arrives.
        event.preventDefault();
        const names = unsaved.map((pane) => paneLabel(pane)).join(", ");
        const leave = await dialog.confirm(
          `${names} ${unsaved.length === 1 ? "has" : "have"} unsaved changes. Close jterm anyway?`,
          "Unsaved changes",
        );
        if (leave) {
          await flushPersistence();
          await win.destroy();
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /* ── Keyboard ─────────────────────────────────────────────────────── */

  // Read through a ref so the key handler does not have to be rebuilt — and
  // re-registered — every time the workspace changes.
  const closePaneRef = useRef(closePane);
  closePaneRef.current = closePane;

  /** Do the jterm thing: split jterm's panes, move between jterm's panes. */
  const runLocal = useCallback(
    (id: ActionId, index?: number) => {
      const current = workspaceRef.current;
      const tab = activeTab(current);
      const tabId = tab?.id ?? null;
      const paneId = tab?.focusedPaneId ?? null;
      const kind: PaneKind = tab && paneId ? (tab.panes[paneId]?.kind ?? "terminal") : "terminal";

      switch (id) {
        case "tab.new":
          dispatch({ type: "tab/new", kind: "terminal" });
          return;
        case "tab.next":
          dispatch({ type: "tab/step", delta: 1 });
          return;
        case "tab.prev":
          dispatch({ type: "tab/step", delta: -1 });
          return;
        case "tab.byIndex":
          if (index !== undefined) dispatch({ type: "tab/selectIndex", index });
          return;

        case "pane.splitRight":
        case "pane.splitDown":
          // A split makes another of whatever you are looking at, which is
          // nearly always what is wanted and is one keystroke either way.
          if (tabId && paneId) {
            dispatch({
              type: "pane/split",
              tabId,
              paneId,
              axis: id === "pane.splitRight" ? "x" : "y",
              kind,
            });
          }
          return;

        case "pane.close":
          if (tabId && paneId) void closePaneRef.current(tabId, paneId);
          return;

        case "pane.zoom":
          if (tabId) dispatch({ type: "pane/zoom", tabId });
          return;

        case "pane.focusLeft":
        case "pane.focusRight":
        case "pane.focusUp":
        case "pane.focusDown":
          if (tabId) {
            dispatch({
              type: "pane/focusDirection",
              tabId,
              direction: id.replace("pane.focus", "").toLowerCase() as Direction,
            });
          }
          return;

        case "pane.growLeft":
        case "pane.growRight":
        case "pane.growUp":
        case "pane.growDown":
          if (tabId) {
            dispatch({
              type: "pane/nudge",
              tabId,
              direction: id.replace("pane.grow", "").toLowerCase() as Direction,
            });
          }
          return;

        case "view.zoomIn":
          zoomText("in");
          return;
        case "view.zoomOut":
          zoomText("out");
          return;
        case "view.zoomReset":
          zoomText("reset");
          return;

        case "window.fullscreen":
          void toggleFullscreen();
          return;

        case "window.settings":
          void openSettingsWindow();
          return;

        case "terminal.eof":
          // The way back to end-of-file, which splitting on Mod+D took away.
          if (paneId) terminalHandle(paneId)?.send("\x04");
          return;

        case "edit.copy":
          if (paneId) {
            const selection = terminalHandle(paneId)?.getSelection() ?? "";
            if (selection) void writeClipboard(selection);
          }
          return;

        case "edit.paste":
          if (paneId) {
            const handle = terminalHandle(paneId);
            if (handle) void readClipboard().then((text) => text && handle.paste(text));
          }
          return;
      }
    },
    [],
  );

  /**
   * The same shortcuts, offered to tmux first when the focused pane is in it.
   *
   * This is what "seamless" comes down to. Inside a tmux-backed pane `Mod+D`
   * makes a tmux split, not a jterm one — so the split lands in the session
   * that survives the app, and the muscle memory does not have to know which
   * kind of pane it is aimed at. Tabs are never forwarded: a jterm tab is a
   * window of the app and has no tmux counterpart.
   *
   * tmux declining is not a dead end. `runTmuxAction` resolves false when a
   * focus move has run out of tmux panes to reach, and the jterm move then
   * happens instead — which is how the focus crosses from the last tmux pane to
   * the jterm pane beside it without the user noticing there was a boundary.
   */
  const runAction = useCallback(
    (id: ActionId, index?: number) => {
      const tab = activeTab(workspaceRef.current);
      const pane = tab ? tab.panes[tab.focusedPaneId] : undefined;
      const session = pane?.kind === "terminal" ? pane.tmux : undefined;
      const controlPane = pane?.kind === "terminal" ? pane.tmuxPane : undefined;

      if (session && isTmuxAction(id) && getSettings().tmuxKeys) {
        // In control mode the pane is addressable directly, which is exact;
        // otherwise the best that can be aimed at is the session's own idea of
        // where it is.
        const offer = controlPane
          ? runControlAction(pane!.id, id)
          : runTmuxAction(session, id);
        void offer.then((taken) => {
          if (!taken) runLocal(id, index);
        });
        return;
      }
      runLocal(id, index);
    },
    [runLocal],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const hit = resolve(event);
      if (hit === null) return;

      // Copy and paste are only ours when a terminal has the keyboard. In a
      // notepad or an address bar the platform's own handling is correct, and
      // taking it over would break selection-aware paste.
      if (hit.id === "edit.copy" || hit.id === "edit.paste") {
        const tab = activeTab(workspaceRef.current);
        const pane = tab ? tab.panes[tab.focusedPaneId] : null;
        if (pane?.kind !== "terminal") return;
      }

      // Capture phase, so this runs before xterm sees the key and forwards it
      // to the shell.
      event.preventDefault();
      event.stopPropagation();
      runAction(hit.id, hit.index);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [runAction]);

  // The webview's own context menu is a browser artefact in an app window.
  // Text fields keep theirs, since that one is genuinely useful.
  useEffect(() => {
    if (!isTauri()) return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const tabs = useMemo(() => workspace.tabs, [workspace.tabs]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-0">
      {pickingSession ? (
        <TmuxSessions
          onClose={() => setPickingSession(false)}
          onAttach={(session) => {
            setPickingSession(false);
            dispatch({ type: "tab/open", kind: "terminal", seed: { tmux: session } });
          }}
          onAttachControl={(session) => {
            setPickingSession(false);
            // No tab is made here. tmux is about to say which windows it has,
            // and the tabs come from that — making one now would leave a stray
            // pane beside the ones tmux is about to describe.
            void tmuxControl.attach(session, 80, 24);
          }}
          onDetach={(session) => {
            void tmuxControl.detach(session);
          }}
        />
      ) : null}

      <TabStrip
        tabs={tabs}
        activeTabId={workspace.activeTabId}
        onSelect={(tabId) => dispatch({ type: "tab/select", tabId })}
        onClose={(tabId) => void closeTab(tabId)}
        onNew={(kind) => dispatch({ type: "tab/new", kind })}
        // The label says "Open file…" under a new-tab button, so it makes a tab
        // whatever the preference says.
        onOpenFile={() => void openFile("tab")}
        onTmuxSessions={hasTmux ? () => setPickingSession(true) : null}
        paneMenu={paneMenu}
        sidebarOpen={workspace.sidebarOpen}
        onToggleSidebar={() => dispatch({ type: "ui/sidebar" })}
        onOpenSettings={() => void openSettingsWindow()}
        onReorder={(tabId, toIndex) => dispatch({ type: "tab/reorder", tabId, toIndex })}
        onDragOverWorkspace={setTabDrag}
        onDropInWorkspace={dropTabInWorkspace}
      />

      <div className="flex min-h-0 flex-1">
        {workspace.sidebarOpen ? (
          <div
            className="shrink-0 border-r border-border"
            style={{ width: settings.sidebarWidth }}
          >
            {sidebarRoot ? (
              <FileTree
                root={sidebarRoot}
                onOpen={openPath}
                onRootChange={setSidebarRoot}
              />
            ) : null}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          {/* Under the panes, and drawn whether or not they have loaded yet:
              this is the one thing on screen that has nothing to wait for. */}
          <AmbientBackdrop />
          {loaded ? (
            <PaneWorkspace
              tabs={tabs}
              activeTabId={workspace.activeTabId}
              dispatch={dispatch}
              onClosePane={(tabId, paneId) => void closePane(tabId, paneId)}
              paneMenu={paneMenu}
              tabDrag={tabDrag}
              onTabDropTarget={noteTabDropTarget}
            />
          ) : null}
        </div>
      </div>

      <ResizeHandles />
      <WindowFrame />
    </div>
  );
}

async function toggleFullscreen(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

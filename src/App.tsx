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

import { FileTree } from "@/components/shell/FileTree";
import { PaneGrid } from "@/components/shell/PaneGrid";
import { SettingsDialog } from "@/components/shell/SettingsDialog";
import { ResizeHandles } from "@/components/shell/ResizeHandles";
import { TabStrip } from "@/components/shell/TabStrip";
import { readClipboard, writeClipboard } from "@/lib/clipboard";
import { dialog, fs, history as historyApi, scrollback as scrollbackApi, session } from "@/lib/ipc";
import { kindForPath } from "@/lib/filetypes";
import { resolve, type ActionId } from "@/lib/keymap";
import {
  configurePersistence,
  flushPersistence,
  installFlushTriggers,
  markDirty,
} from "@/lib/persist";
import { isTauri } from "@/lib/tauri";
import { terminalHandle } from "@/lib/terminals";
import { disposePane } from "@/panes/registry";
import { loadContent, onContentChange, snapshotContent } from "@/state/content";
import { decode, encode } from "@/state/snapshot";
import type { Direction } from "@/state/tree";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarRoot, setSidebarRoot] = useState<string | null>(null);

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
      void scrollbackApi.prune(live);
      void historyApi.prune(live);
      setLoaded(true);
    })();
  }, []);

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
   * Ask for a file and open it in whichever pane suits it.
   *
   * The dialog decides nothing about the kind of pane: the extension does, in
   * `kindForPath`. That keeps "what opens a `.stl`" in one place, shared with
   * every other route a file could arrive by.
   */
  const openPath = useCallback((path: string) => {
    dispatch({ type: "tab/open", kind: kindForPath(path), seed: { path } as Partial<PaneState> });
  }, []);

  const openFile = useCallback(async () => {
    const path = await dialog.open();
    if (path) openPath(path);
  }, [openPath]);

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

  const runAction = useCallback(
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

        case "window.fullscreen":
          void toggleFullscreen();
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
      <TabStrip
        tabs={tabs}
        activeTabId={workspace.activeTabId}
        onSelect={(tabId) => dispatch({ type: "tab/select", tabId })}
        onClose={(tabId) => void closeTab(tabId)}
        onNew={(kind) => dispatch({ type: "tab/new", kind })}
        onOpenFile={() => void openFile()}
        sidebarOpen={workspace.sidebarOpen}
        onToggleSidebar={() => dispatch({ type: "ui/sidebar" })}
        onOpenSettings={() => setSettingsOpen(true)}
        onReorder={(tabId, toIndex) => dispatch({ type: "tab/reorder", tabId, toIndex })}
      />

      <div className="flex min-h-0 flex-1">
        {workspace.sidebarOpen ? (
          <div className="w-[220px] shrink-0 border-r border-border">
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
        {loaded
          ? tabs.map((tab) => {
              const isActive = tab.id === workspace.activeTabId;
              return (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{
                    // Hidden, not unmounted, and not `display: none` — see the
                    // note at the top of `PaneGrid`.
                    visibility: isActive ? "visible" : "hidden",
                    pointerEvents: isActive ? "auto" : "none",
                    zIndex: isActive ? 1 : 0,
                  }}
                >
                  <PaneGrid
                    tab={tab}
                    active={isActive}
                    dispatch={dispatch}
                    onClosePane={(paneId) => void closePane(tab.id, paneId)}
                  />
                </div>
              );
            })
          : null}
        </div>
      </div>

      {settingsOpen ? (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onImported={(snapshot) => {
            const restored = decode(snapshot);
            if (!restored) return;
            loadContent(restored.content);
            dispatch({ type: "restore", workspace: restored.workspace });
            setSettingsOpen(false);
          }}
        />
      ) : null}

      <ResizeHandles />
    </div>
  );
}

async function toggleFullscreen(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

/**
 * Every call into the Rust side, in one place and typed.
 *
 * Each one is a no-op when the app is running in a plain browser (`npm run
 * dev` without Tauri), so the chrome can be worked on without a backend and
 * without every component growing its own guard.
 */

import { isTauri } from "./tauri";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The IPC entry point, resolved once.
 *
 * This used to be a dynamic `import()` inside `call`, which put a module
 * resolution and an extra turn of the microtask queue in front of *every*
 * message — including the one carrying each keystroke to the shell. The module
 * is cached after the first load, so it was never expensive, but the hot path
 * of a terminal is not the place for work that can be done once.
 */
let invoke: Invoke | null = null;
let loading: Promise<void> | null = null;

function ready(): Promise<void> {
  if (loading === null) {
    loading = import("@tauri-apps/api/core").then((core) => {
      invoke = core.invoke as Invoke;
    });
  }
  return loading;
}

async function call<T>(command: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  if (!isTauri()) return fallback;
  if (invoke === null) await ready();
  return invoke!<T>(command, args);
}

export interface SpawnInfo {
  pid: number | null;
  shell: string;
  cwd: string;
  /** The tmux session the shell ended up in, or null for a bare one. Asking for
   *  tmux does not guarantee getting it — see `pty_spawn` in the Rust side. */
  tmux: string | null;
}

/** What a poll of a live terminal finds out about it. */
export interface Probe {
  cwd: string | null;
  /** Whether tmux is between jterm and the shell at this moment. */
  tmux: boolean;
}

export const pty = {
  spawn: (args: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
    /** Attach to (or create) this tmux session instead of running a shell. */
    tmux?: string;
  }): Promise<SpawnInfo | null> => call("pty_spawn", args, null),

  /**
   * Reconnect to the shell `id` already has, or `null` if it has none.
   *
   * The counterpart to `spawn`, which restarts. A pane mounts on every reload
   * of the webview — including the one `recover.rs` performs after WebKit's
   * renderer dies — and spawning there would kill a shell that never stopped
   * running. See `pty_attach` on the Rust side.
   */
  attach: (id: string, cols: number, rows: number): Promise<SpawnInfo | null> =>
    call("pty_attach", { id, cols, rows }, null),

  write: (id: string, data: string) => call("pty_write", { id, data }, undefined),

  resize: (id: string, cols: number, rows: number) =>
    call("pty_resize", { id, cols, rows }, undefined),

  kill: (id: string) => call("pty_kill", { id }, undefined),

  probe: (id: string): Promise<Probe> =>
    call("pty_probe", { id }, { cwd: null, tmux: false }),
};

export interface TmuxSession {
  name: string;
  windows: number;
  /** True when some client — a jterm pane, or a terminal elsewhere — has it. */
  attached: boolean;
}

/**
 * tmux, when the machine has it.
 *
 * `available` is false on Windows and on any machine without tmux installed,
 * and every caller treats that as "this feature is switched off here" rather
 * than as an error. `paneCommand` sends jterm's own pane shortcuts to tmux; see
 * `lib/tmux.ts` for which ones and why.
 */
export const tmux = {
  available: (): Promise<boolean> => call("tmux_available", {}, false),
  sessions: (): Promise<TmuxSession[]> => call("tmux_sessions", {}, []),
  /** Resolves to whether tmux took the action; false means jterm should. */
  paneCommand: (session: string, action: string): Promise<boolean> =>
    call("tmux_pane_command", { session, action }, false),
  killSession: (session: string) => call("tmux_kill_session", { session }, undefined),
};

/**
 * Control mode: tmux describing itself so jterm can draw it.
 *
 * `attach` returns as soon as the client is up; the session's shape arrives on
 * `TMUX_WINDOWS_EVENT`, which is also how every later change arrives, so there
 * is one path rather than a first-time one and a steady-state one.
 */
export const tmuxControl = {
  attach: (session: string, cols: number, rows: number) =>
    call("tmux_control_attach", { session, cols, rows }, undefined),
  detach: (session: string) => call("tmux_control_detach", { session }, undefined),
  attached: (): Promise<string[]> => call("tmux_control_attached", {}, []),
  /** Resolves to whether tmux took the action; false means jterm should. */
  paneCommand: (pane: string, action: string): Promise<boolean> =>
    call("tmux_control_pane_command", { pane, action }, false),
  /** Ask tmux to re-send what a pane already has on screen. Called by the pane
   *  once it is listening, since anything sent before that is dropped. */
  capture: (pane: string) => call("tmux_control_capture", { pane }, undefined),
};

/** Raised whenever the shape of a control session changes. */
export const TMUX_WINDOWS_EVENT = "tmux://windows";
/** Raised when a control session ends, however it ended. */
export const TMUX_CLOSED_EVENT = "tmux://closed";

export const session = {
  save: (json: string) => call("session_save", { json }, undefined),
  load: (): Promise<string | null> => call("session_load", {}, null),
  dir: (): Promise<string> => call("session_dir", {}, ""),
};

/**
 * The preferences file, which is not the session file — see `state/settings.ts`
 * for why the two are kept apart. Saving also announces the change to every
 * open window; the backend does that, not this side.
 */
export const settings = {
  save: (json: string) => call("settings_save", { json }, undefined),
  load: (): Promise<string | null> => call("settings_load", {}, null),
};

export const scrollback = {
  read: (id: string): Promise<string> => call("scrollback_read", { id }, ""),
  drop: (id: string) => call("scrollback_drop", { id }, undefined),
  prune: (keep: string[]) => call("scrollback_prune", { keep }, undefined),
};

export interface TextFile {
  path: string;
  contents: string;
  /** The file was not valid UTF-8 and had to be repaired to be shown. Saving
   *  it back would destroy whatever the bad bytes were, so the editor refuses. */
  lossy: boolean;
}

export const files = {
  readText: (path: string): Promise<TextFile | null> =>
    call("file_read_text", { path }, null),

  writeText: (path: string, contents: string) =>
    call("file_write_text", { path, contents }, undefined),
};

/**
 * A `file://` path turned into something the webview will load.
 *
 * Images and video go through this rather than through IPC: the platform can
 * stream a two-gigabyte video from an `asset:` URL, and cannot sensibly hand
 * the same file over as a JSON payload.
 */
export async function assetUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

/**
 * Hand a local path to whatever the desktop opens it with.
 *
 * Not `openExternal`: the opener plugin restricts `openUrl` by scheme, and a
 * `file://` URL is refused there. Paths have their own command.
 */
export async function openPath(path: string): Promise<void> {
  if (!isTauri()) return;
  const { openPath: open } = await import("@tauri-apps/plugin-opener");
  await open(path);
}

/** Hand a URL to the user's real browser. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  hidden: boolean;
}

export const fs = {
  list: async (path: string): Promise<DirEntry[]> => {
    // Rust names these in snake_case; renaming at the boundary keeps the rest
    // of the frontend from having to know that.
    const raw = await call<{ name: string; path: string; is_dir: boolean; hidden: boolean }[]>(
      "dir_list",
      { path },
      [],
    );
    return raw.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDir: entry.is_dir,
      hidden: entry.hidden,
    }));
  },

  parent: (path: string): Promise<string | null> => call("dir_parent", { path }, null),

  home: (): Promise<string> => call("dir_home", {}, "/"),
};

export interface ExportSummary {
  path: string;
  lines: number;
  bytes: number;
}

/** One command that `history.search` found, and where it was run. */
export interface HistoryHit {
  pane: string;
  text: string;
  cwd: string | null;
  at: string | null;
  /** The exit status, where the shell reported one. See `lib/osc.ts`. */
  code: number | null;
  /** How long it ran, in milliseconds, where that is known. */
  ms: number | null;
}

/**
 * The JSONL every terminal writes, and the single file the whole session folds
 * into. See `src-tauri/src/history.rs` for the format.
 */
export const history = {
  append: (id: string, record: unknown) =>
    call("history_append", { id, record: JSON.stringify(record) }, undefined),

  read: (id: string): Promise<string> => call("history_read", { id }, ""),

  /** Every recorded command matching `query`, newest first, deduplicated. */
  search: (query: string, limit?: number): Promise<HistoryHit[]> =>
    call("history_search", { query, limit }, []),

  drop: (id: string) => call("history_drop", { id }, undefined),

  prune: (keep: string[]) => call("history_prune", { keep }, undefined),

  path: (id: string): Promise<string> => call("history_path", { id }, ""),

  export: (path: string): Promise<ExportSummary | null> =>
    call("history_export", { path }, null),

  /** Returns the restored session snapshot, or null if the file carried none. */
  import: (path: string): Promise<string | null> => call("history_import", { path }, null),
};

export const dialog = {
  /** Returns the chosen path, or null if the dialog was dismissed. */
  open: async (): Promise<string | null> => {
    if (!isTauri()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: false, directory: false });
    return typeof chosen === "string" ? chosen : null;
  },

  /** Open, restricted to one extension — used for importing a session file. */
  openFiltered: async (name: string, extensions: string[]): Promise<string | null> => {
    if (!isTauri()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
    return typeof chosen === "string" ? chosen : null;
  },

  save: async (defaultPath?: string): Promise<string | null> => {
    if (!isTauri()) return null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save(defaultPath ? { defaultPath } : {})) ?? null;
  },

  /** A yes/no the caller must not proceed past without an answer. */
  confirm: async (message: string, title: string): Promise<boolean> => {
    if (!isTauri()) return true;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(message, { title, kind: "warning" });
  },

  notify: async (message: string, title: string): Promise<void> => {
    if (!isTauri()) return;
    const { message: show } = await import("@tauri-apps/plugin-dialog");
    await show(message, { title });
  },

  /** Ask before throwing away unsaved work. */
  confirmDiscard: async (name: string): Promise<boolean> => {
    if (!isTauri()) return true;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return ask(`${name} has unsaved changes. Close it anyway?`, {
      title: "Unsaved changes",
      kind: "warning",
    });
  },
};

/** Subscribe to a backend event, resolving to the unsubscribe function. */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen: tauriListen } = await import("@tauri-apps/api/event");
  return tauriListen<T>(event, (message) => handler(message.payload));
}

/** Say something to every window, this one included. */
export async function emitAll(event: string, payload: unknown): Promise<void> {
  if (!isTauri()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
}

/** Raised by the backend after the settings file has been rewritten. */
export const SETTINGS_CHANGED_EVENT = "settings://changed";

/**
 * Raised by the settings window after an import, carrying the restored
 * snapshot. The main window is the one holding the workspace, so it is the one
 * that has to act on it.
 */
export const SESSION_IMPORTED_EVENT = "session://imported";

export interface PtyData {
  id: string;
  chunk: string;
}

export interface PtyExit {
  id: string;
  code: number | null;
}

export const PTY_DATA_EVENT = "pty://data";
export const PTY_EXIT_EVENT = "pty://exit";

/**
 * Every call into the Rust side, in one place and typed.
 *
 * Each one is a no-op when the app is running in a plain browser (`npm run
 * dev` without Tauri), so the chrome can be worked on without a backend and
 * without every component growing its own guard.
 */

import { isTauri } from "./tauri";
import type { RdpEvent, RdpInput } from "./rdp";
import type { Service as SharingService, SharingStatus } from "./sharing";
import type { IncomingMessage, Transport } from "./vncSocket";

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

/**
 * A terminal's area in pixels, for the pty's `ws_xpixel`/`ws_ypixel`.
 *
 * How a program works out how many pixels a cell is, which is what it needs
 * before it can draw a picture at the right size — see `pixelGeometry` in
 * `panes/TerminalPane.tsx`. Optional everywhere, because zero is the field's
 * "unknown" and a caller with nothing to measure should say that rather than
 * guess.
 */
export interface PixelSize {
  pixelWidth: number;
  pixelHeight: number;
}

export const pty = {
  spawn: (args: {
    id: string;
    cols: number;
    rows: number;
    pixelWidth?: number;
    pixelHeight?: number;
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
  attach: (
    id: string,
    cols: number,
    rows: number,
    pixels?: PixelSize,
  ): Promise<SpawnInfo | null> => call("pty_attach", { id, cols, rows, ...pixels }, null),

  write: (id: string, data: string) => call("pty_write", { id, data }, undefined),

  resize: (id: string, cols: number, rows: number, pixels?: PixelSize) =>
    call("pty_resize", { id, cols, rows, ...pixels }, undefined),

  kill: (id: string) => call("pty_kill", { id }, undefined),

  probe: (id: string): Promise<Probe> =>
    call("pty_probe", { id }, { cwd: null, tmux: false }),

  /** What is running in the pane right now, or `null` for a shell at its prompt. */
  foreground: (id: string): Promise<Foreground | null> =>
    call("pty_foreground", { id }, null),
};

/**
 * The program in the foreground of a pane. See `src-tauri/src/agents.rs`.
 *
 * `session` is the agent's own id for its conversation, which is what lets a
 * pane that died be resumed into *its* conversation rather than whichever one
 * in the directory was most recent. `null` wherever the process did not give
 * it away — every platform but Linux, and every agent that files nothing by
 * process.
 */
export interface Foreground {
  tool: string | null;
  name: string;
  session: string | null;
  cwd: string | null;
  /** An agent's arguments after its name; empty for anything else. */
  args: string[];
}

export interface TmuxSession {
  name: string;
  windows: number;
  /** True when some client — a jterm pane, or a terminal elsewhere — has it. */
  attached: boolean;
  /** Unix seconds of its last activity; 0 when tmux did not say. */
  activity: number;
  /** Where its current pane is, and what is running there. */
  path: string;
  command: string;
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
  /** Whether a session is running *now* — see `tmux_has_session` for why a
   *  restoring pane has to ask before it decides what restoring means. */
  hasSession: (name: string): Promise<boolean> => call("tmux_has_session", { name }, false),
  sessions: (): Promise<TmuxSession[]> => call("tmux_sessions", {}, []),
  /** Resolves to whether tmux took the action; false means jterm should. */
  paneCommand: (session: string, action: string): Promise<boolean> =>
    call("tmux_pane_command", { session, action }, false),
  killSession: (session: string) => call("tmux_kill_session", { session }, undefined),
};

/** Where the welcome dialog's programs are, if anywhere. See `setup_probe`. */
export interface SetupProbe {
  tmux: string | null;
  brew: string | null;
}

export const setup = {
  probe: (): Promise<SetupProbe> => call("setup_probe", {}, { tmux: null, brew: null }),
};

/**
 * A VNC pane's connection — see `vnc.rs`, and `lib/vncSocket.ts` for the
 * socket noVNC is handed. Not through `call`, because two of these need what
 * `call` does not do: a `Channel` for bytes down, and a raw body for bytes up.
 */
export const vnc = {
  transport: (id: string, host: string, port: number): Transport => {
    // Which connection this transport opened, so closing it cannot close a
    // newer one for the same pane. See `vnc_close`.
    let generation: number | null = null;
    return {
      open: async (onMessage) => {
        if (!isTauri()) throw new Error("Remote desktops need the jterm app, not a browser tab.");
        const core = await import("@tauri-apps/api/core");
        const channel = new core.Channel<IncomingMessage>(onMessage);
        generation = await core.invoke<number>("vnc_connect", { id, host, port, onData: channel });
      },
      send: async (bytes) => {
        const core = await import("@tauri-apps/api/core");
        await core.invoke("vnc_send", bytes, { headers: { "x-jterm-vnc": id } });
      },
      close: () => void call("vnc_close", { id, generation }, undefined),
    };
  },
  /** Every connection the pane has, whatever its generation — for disposal. */
  close: (id: string) => call("vnc_close", { id, generation: null }, undefined),
};

/**
 * A Remote Desktop session — see `rdp.rs`. The screen arrives on the channel
 * as binary rectangles (`decodeRect`), and everything else as `RdpEvent`s.
 */
export const rdp = {
  connect: async (
    id: string,
    session: {
      host: string;
      port: number;
      username: string;
      password: string;
      domain?: string;
      trusted?: string;
      width: number;
      height: number;
    },
    onMessage: (message: ArrayBuffer | RdpEvent) => void,
  ): Promise<number> => {
    if (!isTauri()) throw new Error("Remote desktops need the jterm app, not a browser tab.");
    const core = await import("@tauri-apps/api/core");
    const channel = new core.Channel<ArrayBuffer | RdpEvent>(onMessage);
    return core.invoke<number>("rdp_connect", {
      id,
      ...session,
      domain: session.domain ?? null,
      trusted: session.trusted ?? null,
      onEvent: channel,
    });
  },
  input: (id: string, events: RdpInput[]) => call("rdp_input", { id, events }, undefined),
  /** End the session `generation` names, or any, for disposal. See `rdp_close`. */
  close: (id: string, generation: number | null = null) =>
    call("rdp_close", { id, generation }, undefined),
};

/** What this computer shares — see `sharing.rs` and `lib/sharing.ts`. */
export const sharing = {
  status: (): Promise<SharingStatus | null> => call("sharing_status", {}, null),
  /** Resolves to whether a settings page was opened. */
  open: (service: SharingService): Promise<boolean> =>
    call("open_sharing_settings", { service }, false),
};

/** See `permissions.rs`. `notApplicable` off macOS and outside a `.app`. */
export type AppManagement = "granted" | "blocked" | "notWritable" | "notApplicable";

export const permissions = {
  appManagement: (): Promise<AppManagement> =>
    call("app_management_status", {}, "notApplicable" as AppManagement),
  openAppManagement: () => call("open_app_management", {}, undefined),
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

/** A machine the remote-host panel can offer — see `ssh_hosts` in `ssh.rs`. */
export interface SshHost {
  /** What the user calls it: `gb10`. */
  name: string;
  /** What ssh is given: `gb10`, or `me@10.0.0.7` when it came from an alias. */
  target: string;
}

export interface RemoteListing {
  /** False when the host has no tmux, so there is nothing to draw as panes. */
  tmux: boolean;
  sessions: TmuxSession[];
}

/**
 * Other machines, over ssh. Attaching to one of their sessions is
 * `tmuxControl.attach("host:name", …)` — see `lib/remote.ts`.
 */
/** Another jterm's saved window and the tmux panes behind it — see
 *  `ssh_jterm_layout` and `lib/peer.ts`. */
export interface PeerLayout {
  snapshot: string | null;
  panes: { session: string; pane: string }[];
}

export const ssh = {
  hosts: (): Promise<SshHost[]> => call("ssh_hosts", {}, []),
  /** Rejects with ssh's own reason when the host cannot be reached. */
  tmuxSessions: (host: string): Promise<RemoteListing> =>
    call("ssh_tmux_sessions", { host }, { tmux: false, sessions: [] }),
  /** Rejects with ssh's reason, like `tmuxSessions`. */
  jtermLayout: (host: string): Promise<PeerLayout> =>
    call("ssh_jterm_layout", { host }, { snapshot: null, panes: [] }),
};

/** Raised whenever the shape of a control session changes. */
export const TMUX_WINDOWS_EVENT = "tmux://windows";
/** Raised when a control session ends, however it ended. */
export const TMUX_CLOSED_EVENT = "tmux://closed";
/** Raised, before `TMUX_CLOSED_EVENT`, for a session that ended before tmux
 *  ever spoke — an ssh that could not connect. Carries the reason. */
export const TMUX_FAILED_EVENT = "tmux://failed";
/** Raised *instead of* `TMUX_CLOSED_EVENT` when a remote session's connection
 *  dropped. The session is still running over there; its tabs stay. */
export const TMUX_LOST_EVENT = "tmux://lost";
export interface TmuxFailure {
  session: string;
  message: string;
}

/**
 * The session snapshot, which is per *window*.
 *
 * `save` and `load` are always about the window that called them — the backend
 * takes the label from the webview rather than from an argument, so no window
 * can write over another's file. `loadWindow` is the one exception, and exists
 * for the one job that needs it: the main window reads the others' snapshots at
 * launch to work out which panes are still live before pruning anything.
 */
export const session = {
  save: (json: string) => call("session_save", { json }, undefined),
  load: (): Promise<string | null> => call("session_load", {}, null),
  /** Forget this window's snapshot, because it was closed on purpose. */
  drop: () => call("session_drop", {}, undefined),
  /** The labels of extra windows with a snapshot, for the main one to reopen. */
  windows: (): Promise<string[]> => call("session_windows", {}, []),
  loadWindow: (label: string): Promise<string | null> =>
    call("session_load_window", { label }, null),
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

/**
 * Files opened and panes closed, shared by every window.
 *
 * The merge happens in the backend rather than here — see `push_recent` — so
 * two windows closing a tab at the same moment cannot lose each other's entry.
 */
export const recents = {
  list: (): Promise<string> => call("recents_list", {}, "[]"),
  /** One entry as JSON. It needs a `key`; the backend refuses one without. */
  push: (entry: string) => call("recents_push", { entry }, undefined),
  forget: (key: string) => call("recents_forget", { key }, undefined),
};

export const scrollback = {
  read: (id: string): Promise<string> => call("scrollback_read", { id }, ""),
  /**
   * What to draw in a pane whose shell did not survive: the saved screen where
   * there is a fresh one, the raw log otherwise. See `Store::read_restore`.
   */
  restore: (id: string): Promise<string> => call("restore_read", { id }, ""),
  /** Keep what the pane's emulator is showing. See `Store::save_screen`. */
  saveScreen: (id: string, text: string) => call("screen_save", { id, text }, undefined),
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

/* ── The sidebar ─────────────────────────────────────────────────────────── */

/**
 * The sidebar's agent. A pty like a terminal's, but started by the backend's
 * `pty_spawn_agent`, which decides the program from the agent's id and plugs
 * jterm's MCP server into it — the token for that never passes through here.
 * Once started it is written to, resized and killed through `pty`.
 */
export const agentPty = {
  spawn: (args: {
    id: string;
    cols: number;
    rows: number;
    pixelWidth?: number;
    pixelHeight?: number;
    cwd?: string;
    shell?: string;
    tool: string;
    /** Replaces the agent's own name when non-empty. Already split into words. */
    command: string[];
    args: string[];
  }): Promise<SpawnInfo | null> => call("pty_spawn_agent", args, null),
};

/** One changed file, in git's own terms. See `src-tauri/src/git.rs`. */
export interface GitFile {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  orig: string | null;
  /** The index column of `git status --short`; `.` for unchanged. */
  staged: string;
  /** The worktree column; `?` for untracked. */
  unstaged: string;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  root: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

export type GitAction = "push" | "pull" | "fetch" | "init";

/**
 * What a diff pane compares: the worktree against the index (with untracked
 * files), the index against `HEAD`, or one commit against its first parent.
 */
export type GitDiffSource = "worktree" | "staged" | "commit";

/** A commit's particulars, for the header of a diff pane showing it. */
export interface GitCommitDetail {
  hash: string;
  short: string;
  author: string;
  email: string;
  /** ISO 8601. */
  date: string;
  /** "3 hours ago", as git words it. */
  when: string;
  subject: string;
  body: string;
}

/** A diff for a pane. See `git_diff_view` in `src-tauri/src/git.rs`. */
export interface GitDiffView {
  /** The repository's top level — possibly above the directory asked about. */
  root: string;
  /** Unified diff text; read it with `parseDiff` from `lib/diff`. */
  text: string;
  /** The text was cut at the size cap (a few MB) and stops short of the whole. */
  truncated: boolean;
  /** Untracked files that exist but were left out of a worktree diff. */
  untrackedOmitted: number;
  commit: GitCommitDetail | null;
}

export const git = {
  /** `null` for a directory that is in no repository. */
  status: (cwd: string): Promise<GitStatus | null> => call("git_status", { cwd }, null),
  stage: (root: string, paths: string[]) => call("git_stage", { root, paths }, undefined),
  unstage: (root: string, paths: string[]) => call("git_unstage", { root, paths }, undefined),
  commit: (root: string, message: string): Promise<string> =>
    call("git_commit", { root, message }, ""),
  diff: (root: string, path: string, staged: boolean, untracked: boolean): Promise<string> =>
    call("git_diff", { root, path, staged, untracked }, ""),
  log: (root: string, limit?: number): Promise<GitCommit[]> => call("git_log", { root, limit }, []),
  /**
   * A whole diff for a pane to read. `cwd` may be anywhere in the repository.
   * Resolves to `null` for a directory in no repository; rejects with git's
   * words — or "git is not installed" — when it could not be asked.
   */
  diffView: (args: {
    cwd: string;
    source: GitDiffSource;
    /** For `commit`: any revision git understands. Defaults to `HEAD`. */
    rev?: string;
    /** Narrow to one path, relative to the repository root. */
    path?: string;
  }): Promise<GitDiffView | null> => call("git_diff_view", args, null),
  /** Resolves to what git said; rejects with what git said when it failed. */
  action: (cwd: string, action: GitAction): Promise<string> =>
    call("git_action", { cwd, action }, ""),
};

/** A matching line, already cut around the match. See `src-tauri/src/search.rs`. */
export interface SearchHit {
  line: number;
  before: string;
  matched: string;
  after: string;
}

export interface SearchFile {
  path: string;
  rel: string;
  hits: SearchHit[];
}

export interface SearchResult {
  files: SearchFile[];
  /** Paths, relative to the searched directory, whose names match. */
  names: string[];
  scanned: number;
  truncated: boolean;
  /** A newer search started first; this one's answer is partial. */
  superseded: boolean;
}

export const search = {
  files: (root: string, query: string, caseSensitive: boolean): Promise<SearchResult> =>
    call("search_files", { root, query, caseSensitive }, {
      files: [],
      names: [],
      scanned: 0,
      truncated: false,
      superseded: false,
    }),
};

/**
 * A tool call from an agent, handed to the window it belongs to. See
 * `src-tauri/src/mcp.rs` for the server and `lib/mcp.ts` for the tools.
 */
export interface McpRequest {
  id: number;
  window: string;
  method: string;
  params: unknown;
}

export const MCP_REQUEST_EVENT = "mcp://request";

export const mcp = {
  respond: (id: number, result: unknown, error?: string) =>
    call("mcp_respond", { id, result: result ?? null, error: error ?? null }, undefined),
};

/**
 * jterm updating itself. See `src-tauri/src/updater.rs` for the policy and
 * `lib/updates.ts` for the store every window reads it through.
 */
export interface UpdateState {
  current: string;
  /** Why this copy cannot update itself; `null` when it can. */
  unsupported: string | null;
  /** `quiet` installs without asking anything; `password` goes through the
   *  desktop's password prompt; `quits` closes jterm while the installer runs. */
  install: "quiet" | "password" | "quits";
  available: { version: string; notes: string | null; date: string | null } | null;
  installing: boolean;
  /** A version installed and waiting on a restart. */
  installed: string | null;
  error: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export const updates = {
  state: (): Promise<UpdateState | null> => call("update_state", {}, null),
  check: (): Promise<UpdateState | null> => call("update_check", {}, null),
  install: (): Promise<UpdateState | null> => call("update_install", {}, null),
  restart: () => call("update_restart", {}, undefined),
};

export const UPDATE_STATE_EVENT = "update://state";
export const UPDATE_PROGRESS_EVENT = "update://progress";

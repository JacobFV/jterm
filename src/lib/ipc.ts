/**
 * Every call into the Rust side, in one place and typed.
 *
 * Each one is a no-op when the app is running in a plain browser (`npm run
 * dev` without Tauri), so the chrome can be worked on without a backend and
 * without every component growing its own guard.
 */

import { isTauri } from "./tauri";

async function call<T>(command: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  if (!isTauri()) return fallback;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export interface SpawnInfo {
  pid: number | null;
  shell: string;
  cwd: string;
}

export const pty = {
  spawn: (args: {
    id: string;
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
  }): Promise<SpawnInfo | null> => call("pty_spawn", args, null),

  write: (id: string, data: string) => call("pty_write", { id, data }, undefined),

  resize: (id: string, cols: number, rows: number) =>
    call("pty_resize", { id, cols, rows }, undefined),

  kill: (id: string) => call("pty_kill", { id }, undefined),

  cwd: (id: string): Promise<string | null> => call("pty_cwd", { id }, null),
};

export const session = {
  save: (json: string) => call("session_save", { json }, undefined),
  load: (): Promise<string | null> => call("session_load", {}, null),
  dir: (): Promise<string> => call("session_dir", {}, ""),
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

/** Hand a URL to the user's real browser. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export const dialog = {
  /** Returns the chosen path, or null if the dialog was dismissed. */
  open: async (): Promise<string | null> => {
    if (!isTauri()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: false, directory: false });
    return typeof chosen === "string" ? chosen : null;
  },

  save: async (defaultPath?: string): Promise<string | null> => {
    if (!isTauri()) return null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save(defaultPath ? { defaultPath } : {})) ?? null;
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

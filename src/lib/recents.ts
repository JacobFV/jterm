/**
 * What was open before: files you have opened, and panes you have closed.
 *
 * Two lists in one, because they answer the same question from two directions
 * — "put back the thing I was looking at" — and because a single, capped,
 * newest-first list is the whole data structure either of them needs.
 *
 * It is kept in the backend's own file rather than in a window's snapshot:
 * every window shares it, and a snapshot belongs to one window. The merging
 * happens over there too, so two windows closing a tab at the same moment
 * cannot lose each other's entry. See `push_recent`.
 *
 * A **session** entry is a pane that was closed, with enough of it to make the
 * same pane again: what it was, where it was, and what it was running. Opening
 * one does not resurrect a process — the process is gone, and nothing here
 * pretends otherwise — it makes a pane in the same place with the command
 * typed at the prompt, which is as far as honesty goes.
 *
 * Everything read back is validated. The file is small, but it sits in a
 * user-writable directory and its contents end up as a menu of things that
 * become panes.
 */

import { fileName } from "./filetypes";
import { recents as recentsApi } from "./ipc";
import type { PaneKind, PaneState } from "@/state/workspace";

/** Kinds a pane can be remembered as. Anything else is not worth a menu row. */
const REMEMBERED: PaneKind[] = ["terminal", "notepad", "browser", "image", "media", "model"];

export interface RecentFile {
  key: string;
  kind: "file";
  at: string;
  label: string;
  path: string;
}

export interface RecentSession {
  key: string;
  kind: "session";
  at: string;
  label: string;
  pane: PaneKind;
  /** Where the shell was, so the pane comes back in the same directory. */
  cwd?: string;
  /** What it was running, which is both the icon and the line typed back. */
  command?: string;
  /** An icon the user pinned; carried so a remade pane still wears it. */
  profile?: string;
  path?: string;
  url?: string;
}

export type Recent = RecentFile | RecentSession;

/* ── Remembering ─────────────────────────────────────────────────────────── */

/** A file, remembered by its path — opening the same one twice is one entry. */
export function rememberFile(path: string): void {
  if (!path) return;
  void push({
    key: `file:${path}`,
    kind: "file",
    at: new Date().toISOString(),
    label: fileName(path),
    path,
  });
}

/**
 * A pane that is being closed.
 *
 * Ignores the ones there would be nothing to come back to: a terminal that
 * never ran anything and never left the directory it started in, and a note
 * that was never saved anywhere. Both would be a menu row that makes an empty
 * pane, which is what the New tab button is already for.
 *
 * The key is what the pane *is* rather than its id, so closing the same project
 * shell for the fifth time leaves one row rather than five.
 */
export function rememberPane(pane: PaneState): void {
  if (!REMEMBERED.includes(pane.kind)) return;
  const at = new Date().toISOString();

  switch (pane.kind) {
    case "terminal": {
      if (!pane.command && !pane.cwd) return;
      void push({
        key: `session:terminal:${pane.command ?? ""}:${pane.cwd ?? ""}`,
        kind: "session",
        at,
        label: pane.command || shortPath(pane.cwd ?? "") || "Terminal",
        pane: "terminal",
        cwd: pane.cwd,
        command: pane.command,
        profile: pane.profile,
      });
      return;
    }
    case "browser": {
      void push({
        key: `session:browser:${pane.url}`,
        kind: "session",
        at,
        label: pane.title || pane.url,
        pane: "browser",
        url: pane.url,
        profile: pane.profile,
      });
      return;
    }
    default: {
      // The file-backed panes. A note with no path exists only in the snapshot
      // that is about to stop mentioning it, so there is nothing to point at.
      const path = pane.kind === "notepad" ? pane.path : pane.path;
      if (!path) return;
      void push({
        key: `file:${path}`,
        kind: "file",
        at,
        label: fileName(path),
        path,
      });
    }
  }
}

async function push(entry: Recent): Promise<void> {
  try {
    await recentsApi.push(JSON.stringify(entry));
  } catch (error) {
    // Losing an entry costs a menu row. It must never cost the close that was
    // being performed when it happened.
    console.error("[jterm] could not remember that", error);
  }
}

export function forgetRecent(key: string): Promise<void> {
  return recentsApi.forget(key);
}

/* ── Reading it back ─────────────────────────────────────────────────────── */

export async function listRecents(): Promise<Recent[]> {
  return decodeRecents(await recentsApi.list());
}

/**
 * The stored list, validated entry by entry.
 *
 * One bad entry is dropped rather than costing the list, which is the rule the
 * session snapshot is decoded by and for the same reason: this is a file on
 * disk that anyone can edit, and the menu it becomes creates panes.
 */
export function decodeRecents(json: string | null | undefined): Recent[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Recent[] = [];
  for (const raw of parsed) {
    const entry = decodeRecent(raw);
    if (entry !== null) out.push(entry);
  }
  return out;
}

function decodeRecent(raw: unknown): Recent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const key = text(value.key, 400);
  const at = text(value.at, 40);
  const label = text(value.label, 200);
  if (key === undefined || label === undefined) return null;

  if (value.kind === "file") {
    const path = text(value.path, 4096);
    return path === undefined
      ? null
      : { key, kind: "file", at: at ?? "", label, path };
  }

  if (value.kind !== "session") return null;
  const pane = REMEMBERED.find((candidate) => candidate === value.pane);
  if (pane === undefined) return null;

  return {
    key,
    kind: "session",
    at: at ?? "",
    label,
    pane,
    cwd: text(value.cwd, 4096),
    // Capped hard: this one is typed at a prompt, and a menu row is not the
    // place to discover that a file on disk can hold a megabyte of it.
    command: text(value.command, 2000),
    profile: text(value.profile, 64),
    path: text(value.path, 4096),
    url: text(value.url, 4096),
  };
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

/** `/home/me/src/jterm` as `~/src/jterm`, for a row that has to fit in a menu. */
export function shortPath(path: string, home?: string): string {
  if (!path) return "";
  const trimmed = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return trimmed;
}

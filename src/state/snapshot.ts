/**
 * Turning the workspace into bytes and back.
 *
 * Decoding is written as if the file is hostile, because in one important sense
 * it is: it is the file that survived whatever crash we are recovering from, it
 * sits in a user-writable directory, and it may have been written by an older
 * version of the app. Anything unrecognised is dropped rather than trusted, and
 * a tab that fails to validate is discarded on its own so one bad tab does not
 * cost the user the other nine.
 *
 * Returning `null` means "start fresh" and is a normal outcome — first launch
 * takes that path too.
 */

import { isThemeId } from "@/lib/themes";
import type { PaneContent } from "./content";
import type { ThemeChoice } from "./settings";
import type { Node } from "./tree";
import { clampRatio, hasPane, paneIds } from "./tree";
import type { PaneKind, PaneState, Tab, Workspace } from "./workspace";

/** Bumped when the shape changes in a way older files cannot satisfy. */
export const SNAPSHOT_VERSION = 1;

/**
 * Longest draft carried across a restart.
 *
 * A prompt line is short. A megabyte in this field means something has gone
 * wrong upstream, and replaying it into a shell would be worse than losing it.
 */
const MAX_DRAFT = 8 * 1024;
/** Notepads are for notes, not for logs; past this the file stops being cheap. */
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_TABS = 64;

export interface Snapshot {
  workspace: Workspace;
  content: Record<string, PaneContent>;
  /** Control-mode sessions to reattach to. See `encode`. */
  controlSessions: string[];
}

/**
 * The workspace as bytes — minus the parts tmux is already remembering.
 *
 * Control-mode tabs are stripped and their session names kept instead. Writing
 * those tabs down would be recording a shape whose owner is still running: on
 * the next launch tmux is the thing that knows which windows the session has,
 * and reattaching produces the tabs again, correct even if the session changed
 * while jterm was closed. A saved copy could only be right by luck.
 *
 * It also avoids a worse failure. A restored control pane has no pty and no
 * client behind it, so it would mount, spawn nothing, and sit there as a
 * terminal that never says anything.
 */
export function encode(workspace: Workspace, content: Record<string, PaneContent>): string {
  const controlSessions = new Set<string>();
  const tabs = workspace.tabs.filter((tab) => {
    const session = controlSessionOf(tab);
    if (session === null) return true;
    controlSessions.add(session);
    return false;
  });

  const activeTabId = tabs.some((tab) => tab.id === workspace.activeTabId)
    ? workspace.activeTabId
    : (tabs[0]?.id ?? null);

  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    workspace: { ...workspace, tabs, activeTabId },
    content,
    controlSessions: [...controlSessions],
  });
}

/** The control session a tab belongs to, or `null` if it is an ordinary tab. */
function controlSessionOf(tab: Tab): string | null {
  for (const pane of Object.values(tab.panes)) {
    if (pane.kind === "terminal" && pane.tmuxPane !== undefined && pane.tmux) {
      return pane.tmux;
    }
  }
  return null;
}

export function decode(json: string | null | undefined): Snapshot | null {
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.version !== SNAPSHOT_VERSION) return null;

  const rawWorkspace = parsed.workspace;
  if (!isRecord(rawWorkspace) || !Array.isArray(rawWorkspace.tabs)) return null;

  const tabs: Tab[] = [];
  for (const raw of rawWorkspace.tabs.slice(0, MAX_TABS)) {
    const tab = decodeTab(raw);
    if (tab) tabs.push(tab);
  }
  if (tabs.length === 0) return null;

  const activeTabId =
    typeof rawWorkspace.activeTabId === "string" &&
    tabs.some((tab) => tab.id === rawWorkspace.activeTabId)
      ? rawWorkspace.activeTabId
      : tabs[0].id;

  // Contents are kept only for panes that survived validation, so a discarded
  // tab does not leave its drafts behind to grow the file forever.
  const live = new Set(tabs.flatMap((tab) => Object.keys(tab.panes)));
  const content: Record<string, PaneContent> = {};
  if (isRecord(parsed.content)) {
    for (const [paneId, value] of Object.entries(parsed.content)) {
      if (!live.has(paneId) || !isRecord(value)) continue;
      const entry: PaneContent = {};
      if (typeof value.draft === "string") entry.draft = value.draft.slice(0, MAX_DRAFT);
      if (typeof value.text === "string") entry.text = value.text.slice(0, MAX_TEXT);
      if (typeof value.caret === "number" && Number.isFinite(value.caret)) {
        entry.caret = Math.max(0, Math.floor(value.caret));
      }
      if (entry.draft || entry.text) content[paneId] = entry;
    }
  }

  return {
    workspace: { tabs, activeTabId, sidebarOpen: rawWorkspace.sidebarOpen === true },
    content,
    controlSessions: decodeSessions(parsed.controlSessions),
  };
}

/**
 * Session names to reattach to in control mode.
 *
 * Each one is handed to tmux as an argument, so it is length-capped like every
 * other string out of this file — the snapshot lives in a user-writable
 * directory and is read after a crash, which is not the moment to start
 * trusting it.
 */
function decodeSessions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => name.slice(0, 128))
    .slice(0, MAX_TABS);
}

function decodeTab(raw: unknown): Tab | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;

  const panes: Record<string, PaneState> = {};
  if (!isRecord(raw.panes)) return null;
  for (const [paneId, value] of Object.entries(raw.panes)) {
    const pane = decodePane(paneId, value);
    if (pane) panes[paneId] = pane;
  }
  if (Object.keys(panes).length === 0) return null;

  const root = decodeNode(raw.root, panes);
  if (root === null) return null;

  // A pane the tree does not mention can never be reached or closed, so it is
  // dropped rather than kept as an invisible leak.
  const reachable = new Set(paneIds(root));
  for (const paneId of Object.keys(panes)) {
    if (!reachable.has(paneId)) delete panes[paneId];
  }

  const focusedPaneId =
    typeof raw.focusedPaneId === "string" && reachable.has(raw.focusedPaneId)
      ? raw.focusedPaneId
      : paneIds(root)[0];

  const zoomedPaneId =
    typeof raw.zoomedPaneId === "string" && hasPane(root, raw.zoomedPaneId)
      ? raw.zoomedPaneId
      : null;

  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : undefined,
    theme: decodeTheme(raw.theme),
    root,
    panes,
    focusedPaneId,
    zoomedPaneId,
  };
}

/**
 * A tab's or a pane's own theme, if it still names one.
 *
 * `undefined` is both "never chose one" and "chose one this build no longer
 * has", and the two want the same treatment: fall back to the level above,
 * which always resolves to something. A theme that went away should cost the
 * theme, not the tab.
 */
function decodeTheme(raw: unknown): ThemeChoice | undefined {
  return isThemeId(raw) ? raw : undefined;
}

const KINDS: PaneKind[] = ["terminal", "notepad", "browser", "image", "media", "model"];

function decodePane(id: string, raw: unknown): PaneState | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as PaneKind)) return null;
  const title = typeof raw.title === "string" && raw.title ? raw.title.slice(0, 200) : undefined;
  const theme = decodeTheme(raw.theme);

  switch (kind as PaneKind) {
    case "terminal":
      return {
        id,
        kind: "terminal",
        title,
        theme,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
        // Length-capped like every other string out of this file: a session
        // name reaches tmux as an argument, and a hand-edited snapshot is not
        // a thing to hand unbounded input to.
        tmux: typeof raw.tmux === "string" && raw.tmux ? raw.tmux.slice(0, 128) : undefined,
      };
    case "notepad":
      return {
        id,
        kind: "notepad",
        title,
        theme,
        path: typeof raw.path === "string" && raw.path ? raw.path : undefined,
        dirty: raw.dirty === true,
      };

    // A viewer without a file has nothing to show and no way to get one, so it
    // is dropped rather than restored as an empty pane.
    case "image":
    case "media":
    case "model": {
      if (typeof raw.path !== "string" || !raw.path) return null;
      return { id, kind: kind as "image" | "media" | "model", title, theme, path: raw.path };
    }
    case "browser":
      return {
        id,
        kind: "browser",
        title,
        theme,
        // Only http(s) is restored. A `file:` or `javascript:` URL in this file
        // would otherwise be a way to make the app open something it should
        // not, using a file the app itself is expected to trust.
        url: safeUrl(raw.url) ?? "about:blank",
      };
  }
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Validate the split tree, checking every leaf against the panes that exist. */
function decodeNode(raw: unknown, panes: Record<string, PaneState>): Node | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return null;

  if (raw.kind === "leaf") {
    return typeof raw.paneId === "string" && panes[raw.paneId]
      ? { kind: "leaf", id: raw.id, paneId: raw.paneId }
      : null;
  }

  if (raw.kind !== "split") return null;
  if (raw.axis !== "x" && raw.axis !== "y") return null;
  if (!Array.isArray(raw.children) || raw.children.length !== 2) return null;

  const first = decodeNode(raw.children[0], panes);
  const second = decodeNode(raw.children[1], panes);
  // A split with one usable side collapses into that side rather than being
  // thrown away, which keeps a partially-corrupt tab open instead of losing it.
  if (first === null) return second;
  if (second === null) return first;

  return {
    kind: "split",
    id: raw.id,
    axis: raw.axis,
    ratio: clampRatio(typeof raw.ratio === "number" ? raw.ratio : 0.5),
    children: [first, second],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

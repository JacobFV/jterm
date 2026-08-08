/**
 * What the user has chosen, and how a change reaches every window.
 *
 * Kept apart from the session snapshot on purpose. The snapshot is *this
 * machine, this moment* — which tabs are open, what was half-typed at each
 * prompt — and it is rewritten several times a second. Preferences are neither:
 * they change when someone opens Settings, they are the file you would copy to
 * a new machine, and losing them to a corrupt snapshot would be an odd way to
 * lose your theme. So they live in their own `settings.json`.
 *
 * Settings are edited in a window of their own, which means two webviews hold
 * a copy and either can change it. The backend is the referee: a save writes
 * the file and then announces it to every window, the announcing window
 * included. That window sees its own value come back, finds it identical to
 * what it already has, and ignores it — which is why the loop terminates
 * without anyone having to track who started it.
 */

import { applyAppearance } from "@/lib/appearance";
import { SETTINGS_CHANGED_EVENT, listen, settings as settingsApi } from "@/lib/ipc";
import { ACTION_IDS, setKeyOverrides, type ActionId } from "@/lib/keymap";
import { isTauri } from "@/lib/tauri";
import type { Direction } from "./tree";

export type ThemeChoice = "system" | "dark" | "light";
export type CursorStyle = "bar" | "block" | "underline";
/** Where a file goes when you open one: a tab of its own, or a split. */
export type FileOpenTarget = "tab" | "pane";

export interface Settings {
  theme: ThemeChoice;
  /** The chrome's text size. The terminal has its own, below. */
  uiFontSize: number;
  /** Empty means the built-in monospace stack in `index.css`. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Lines xterm keeps in memory. The file on disk is capped separately. */
  scrollback: number;
  /** Empty means whatever the platform considers the login shell. */
  shell: string;
  sidebarWidth: number;
  showHiddenFiles: boolean;
  /** What opening a file does — a new tab, or a split beside what you are
   *  looking at. The tab strip's own `Open file…` always makes a tab; this is
   *  about the file tree and the open dialog. */
  openFilesIn: FileOpenTarget;
  /** Which side of the focused pane a file lands on, when it opens as a pane. */
  openPaneDirection: Direction;
  /** Only what the user changed. Absent means "the default", so a default that
   *  moves in a later version moves for everyone who never touched it. */
  keys: Partial<Record<ActionId, string>>;
}

/**
 * Bounds for every number, shared by the decoder and the controls that edit
 * them. One table so a hand-edited file cannot express a value the UI would
 * refuse to show, and a 400px font cannot make the app unusable enough that
 * you can no longer reach the setting that caused it.
 */
export const LIMITS = {
  uiFontSize: { min: 10, max: 20, step: 0.5 },
  fontSize: { min: 8, max: 32, step: 1 },
  lineHeight: { min: 1, max: 2, step: 0.05 },
  scrollback: { min: 0, max: 200_000, step: 1000 },
  sidebarWidth: { min: 140, max: 600, step: 10 },
} as const;

export const DEFAULTS: Settings = {
  theme: "dark",
  uiFontSize: 12.5,
  fontFamily: "",
  fontSize: 13,
  lineHeight: 1.25,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10_000,
  shell: "",
  sidebarWidth: 220,
  showHiddenFiles: false,
  openFilesIn: "tab",
  openPaneDirection: "right",
  keys: {},
};

const THEMES: ThemeChoice[] = ["system", "dark", "light"];
const CURSORS: CursorStyle[] = ["bar", "block", "underline"];
const FILE_OPEN_TARGETS: FileOpenTarget[] = ["tab", "pane"];
const SPLIT_DIRECTIONS: Direction[] = ["right", "left", "down", "up"];

/* ── Reading the file ────────────────────────────────────────────────────── */

/**
 * Decoded the same way as the session snapshot, and for the same reason: this
 * file sits in a user-writable directory, may have been hand-edited, and may
 * have been written by an older version. Every field falls back to its default
 * on its own, so one bad value costs that value rather than the whole file.
 */
export function decodeSettings(json: string | null | undefined): Settings | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  return {
    theme: pick(parsed.theme, THEMES, DEFAULTS.theme),
    uiFontSize: clamp(parsed.uiFontSize, LIMITS.uiFontSize, DEFAULTS.uiFontSize),
    fontFamily: text(parsed.fontFamily, DEFAULTS.fontFamily),
    fontSize: clamp(parsed.fontSize, LIMITS.fontSize, DEFAULTS.fontSize),
    lineHeight: clamp(parsed.lineHeight, LIMITS.lineHeight, DEFAULTS.lineHeight),
    cursorStyle: pick(parsed.cursorStyle, CURSORS, DEFAULTS.cursorStyle),
    cursorBlink: parsed.cursorBlink === undefined ? DEFAULTS.cursorBlink : parsed.cursorBlink === true,
    scrollback: Math.round(clamp(parsed.scrollback, LIMITS.scrollback, DEFAULTS.scrollback)),
    shell: text(parsed.shell, DEFAULTS.shell),
    sidebarWidth: Math.round(clamp(parsed.sidebarWidth, LIMITS.sidebarWidth, DEFAULTS.sidebarWidth)),
    showHiddenFiles: parsed.showHiddenFiles === true,
    openFilesIn: pick(parsed.openFilesIn, FILE_OPEN_TARGETS, DEFAULTS.openFilesIn),
    openPaneDirection: pick(
      parsed.openPaneDirection,
      SPLIT_DIRECTIONS,
      DEFAULTS.openPaneDirection,
    ),
    keys: decodeKeys(parsed.keys),
  };
}

function decodeKeys(raw: unknown): Partial<Record<ActionId, string>> {
  if (!isRecord(raw)) return {};
  const known = new Set<string>(ACTION_IDS);
  const keys: Partial<Record<ActionId, string>> = {};
  for (const [id, value] of Object.entries(raw)) {
    // An unknown id is an action that no longer exists, or one from a future
    // version; either way there is nothing here it could bind.
    if (!known.has(id) || typeof value !== "string") continue;
    keys[id as ActionId] = value.slice(0, 64);
  }
  return keys;
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.slice(0, 512) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ── The store ───────────────────────────────────────────────────────────── */

type Listener = (settings: Settings) => void;

let current: Settings = DEFAULTS;
let serialized = JSON.stringify(DEFAULTS);
const listeners = new Set<Listener>();

export function getSettings(): Settings {
  return current;
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Take a new set of settings as the truth.
 *
 * Effects run before subscribers: a component reacting to a theme change reads
 * CSS variables to build its own palette (the terminal does exactly this), and
 * it must not be woken until the variables it is about to read have moved.
 */
function adopt(next: Settings, json: string): void {
  current = next;
  serialized = json;
  applyAppearance(next);
  setKeyOverrides(next.keys);
  for (const listener of listeners) listener(next);
}

/**
 * Change some settings and write them down.
 *
 * The write is deferred but the change is not: subscribers see it immediately,
 * so dragging a font size repaints as you drag, while the disk sees one write
 * when you stop rather than one per pixel.
 */
export function updateSettings(patch: Partial<Settings>): void {
  const next: Settings = { ...current, ...patch };
  const json = JSON.stringify(next);
  if (json === serialized) return;
  adopt(next, json);
  schedulePersist();
}

export function resetSettings(): void {
  updateSettings(DEFAULTS);
}

/** Quiet period before a change reaches the disk and the other window. */
const PERSIST_DEBOUNCE_MS = 150;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const json = serialized;
    void settingsApi.save(json);
    channel?.postMessage(json);
  }, PERSIST_DEBOUNCE_MS);
}

/* ── Keeping two windows in step ─────────────────────────────────────────── */

/**
 * The browser's half of the announcement.
 *
 * Under Tauri the backend broadcasts, because it is the thing that owns the
 * file. Under `npm run dev` there is no backend, the second window is a real
 * browser window opened with `window.open`, and `BroadcastChannel` is what
 * reaches it. Both paths end at `receive`.
 */
const channel =
  typeof window === "undefined" || typeof BroadcastChannel === "undefined" || isTauri()
    ? null
    : new BroadcastChannel("jterm-settings");

function receive(json: string | null): void {
  if (json === null || json === serialized) return;
  const decoded = decodeSettings(json);
  if (decoded === null) return;
  // Re-serialised rather than stored as received: the file may be missing
  // fields or carrying junk, and `serialized` is compared against future
  // writes, so it has to be the canonical form of what we now hold.
  adopt(decoded, JSON.stringify(decoded));
}

/**
 * Read the settings file, apply it, and start listening for changes made
 * elsewhere. Awaited before the first render so nothing paints in the wrong
 * theme and then corrects itself.
 */
export async function initSettings(): Promise<Settings> {
  // Nothing is drawn until this resolves, so it must not be able to reject —
  // an app that will not paint because it could not read a preferences file
  // has failed much harder than one running on the defaults.
  const stored = decodeSettings(await settingsApi.load().catch(() => null));
  const initial = stored ?? DEFAULTS;
  adopt(initial, JSON.stringify(initial));

  if (channel !== null) {
    channel.onmessage = (event) => receive(typeof event.data === "string" ? event.data : null);
  } else {
    void listen<string>(SETTINGS_CHANGED_EVENT, receive);
  }

  return current;
}

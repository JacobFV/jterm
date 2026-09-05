/**
 * More than one window, and moving a pane between them.
 *
 * A second window is the same bundle again — the same trick the settings window
 * plays with a hash on the URL, minus the hash. What makes it more than a
 * cosmetic copy is that a pane can be *handed over*: the shell behind a pane is
 * a pty in the Rust process, keyed by pane id and belonging to no window at
 * all, so the pane can leave one webview and arrive in another without the
 * process noticing. Scrollback and history are keyed the same way and follow it
 * for free.
 *
 * The handover is therefore three small things rather than one big one:
 *
 *   1. The sender emits the pane's state and its unsaved content to the target
 *      window and removes it from its own workspace *without disposing it* —
 *      `pane/eject`, which exists purely so that "leaving" and "being killed"
 *      cannot be confused.
 *   2. The receiver adds it. Its `TerminalPane` mounts, calls `pty_attach`,
 *      finds the shell alive and adopts it, then replays the scrollback log —
 *      the same path a webview reload already takes after a renderer crash.
 *   3. For a brand new window there is nobody to receive yet, so the sender
 *      waits for the window to say it is listening before handing anything
 *      over. A pane emitted into a window that has not mounted is a pane that
 *      would simply cease to exist.
 *
 * Everything arriving here is treated as untrusted input even though it came
 * from another window of this app: it is one `emit` away from anything else
 * that can reach the event bus, and it ends up in the workspace.
 */

import { emitTo, listen } from "@tauri-apps/api/event";

import type { PaneContent } from "@/state/content";
import { decodePaneState } from "@/state/snapshot";
import type { PaneState } from "@/state/workspace";
import { usesNativeWindowChrome } from "./platform";
import { isTauri } from "./tauri";

/** The window whose snapshot is the app's own restore point. */
export const MAIN_WINDOW = "main";
/** The settings window is not a workspace and never appears in these lists. */
const SETTINGS_WINDOW = "settings";

const PANE_EVENT = "pane://move";
const READY_EVENT = "workspace://ready";

/** How long a new window is given to mount before a handover is given up on. */
const READY_TIMEOUT_MS = 8000;

export interface WindowRef {
  label: string;
  title: string;
}

export interface PaneHandover {
  pane: PaneState;
  /** The unsaved half — a draft command line, a notepad's buffer. */
  content: PaneContent;
  /**
   * Whether it was floating where it came from.
   *
   * Carried across so a pane arrives as the thing it already was: a pop-up
   * stays a pop-up, a pane in a tab becomes a tab. Anything else would be the
   * move quietly changing the pane as well as moving it.
   */
  as: "tab" | "popup";
}

export function currentWindowLabel(): string {
  if (!isTauri()) return MAIN_WINDOW;
  // Read from the global rather than through the async API: several callers
  // need it during render, and the label cannot change under a window.
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
    .__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label ?? MAIN_WINDOW;
}

export function isMainWindow(): boolean {
  return currentWindowLabel() === MAIN_WINDOW;
}

/** The other workspace windows open right now, for the move menu. */
export async function otherWindows(): Promise<WindowRef[]> {
  if (!isTauri()) return [];
  const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
  const here = currentWindowLabel();
  const found = await getAllWebviewWindows();

  const refs = await Promise.all(
    found
      .filter((candidate) => candidate.label !== here && candidate.label !== SETTINGS_WINDOW)
      .map(async (candidate) => ({
        label: candidate.label,
        // A window is named after what is in it, so the title is the only
        // thing that tells two of them apart in a menu.
        title: await candidate.title().catch(() => candidate.label),
      })),
  );
  return refs;
}

/**
 * Open another workspace window, and a promise for when it can receive panes.
 *
 * The listener is registered *before* the window is created, which is the
 * whole reason this returns the promise rather than leaving the caller to wait
 * afterwards: a window that mounted quickly would announce itself into a gap
 * where nobody was listening, and the handover waiting on it would then time
 * out with the pane still in limbo.
 *
 * The label is minted here and becomes the name of that window's snapshot file,
 * so it is kept to the characters the backend will accept as one.
 */
export async function openWorkspaceWindow(): Promise<{
  label: string;
  ready: Promise<void>;
} | null> {
  if (!isTauri()) {
    window.open(window.location.pathname, "_blank", "width=1100,height=700");
    return null;
  }

  const label = `w-${Math.random().toString(36).slice(2, 10)}`;
  const { ready } = await watchForReady(label);
  await createWindow(label);
  return { label, ready };
}

/** Reopen a window that a previous session left a snapshot for. */
export async function restoreWorkspaceWindow(label: string): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  if ((await WebviewWindow.getByLabel(label)) !== null) return;
  await createWindow(label);
}

async function createWindow(label: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const native = usesNativeWindowChrome();

  new WebviewWindow(label, {
    url: "index.html",
    title: "jterm",
    width: 1100,
    height: 700,
    minWidth: 480,
    minHeight: 320,
    resizable: true,
    // The same split every window in this app lives under: the OS draws the
    // frame on macOS, and jterm draws it everywhere else. See `lib/platform`.
    decorations: native,
    ...(native ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : {}),
  });
}

/** Announce that this window is mounted and can receive panes. */
export async function announceReady(): Promise<void> {
  if (!isTauri()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(READY_EVENT, currentWindowLabel());
}

/**
 * Start listening for one window's "I am up", and hand back the wait.
 *
 * Resolves once the listener is *registered*, so the caller can create the
 * window knowing the announcement cannot be missed. The wait itself is handed
 * back inside an object rather than returned directly — a promise returned
 * from an async function is flattened into it, and this one has to survive as
 * a value. It rejects rather than hanging if the window never comes up: a
 * handover that waits forever is a pane nobody can reach.
 */
async function watchForReady(label: string): Promise<{ ready: Promise<void> }> {
  let settle: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const unlisten = await listen<string>(READY_EVENT, (event) => {
    if (event.payload !== label) return;
    clearTimeout(timer);
    unlisten();
    settle?.();
  });

  const timer = setTimeout(() => {
    unlisten();
    fail?.(new Error(`window ${label} did not come up`));
  }, READY_TIMEOUT_MS);

  // Nothing is awaiting `ready` yet and a rejection with no handler is an
  // unhandled rejection; the caller attaches one the moment it has the object.
  ready.catch(() => {});
  return { ready };
}

/**
 * Hand a pane to another window.
 *
 * Resolves to whether the pane was actually sent. A `false` means the caller
 * must keep it: a pane removed from here and delivered nowhere is a shell with
 * no way back to it.
 */
export async function sendPaneToWindow(label: string, handover: PaneHandover): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await emitTo(label, PANE_EVENT, handover);
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await (await WebviewWindow.getByLabel(label))?.setFocus();
    return true;
  } catch (error) {
    console.error("[jterm] could not hand the pane over", error);
    return false;
  }
}

/**
 * Panes arriving from other windows.
 *
 * Validated through the same decoder the session file goes through, for the
 * same reason: this is a payload off the event bus, and the only difference
 * between it and a snapshot is which direction it came from.
 */
export function onPaneHandover(handle: (handover: PaneHandover) => void): () => void {
  if (!isTauri()) return () => {};
  let stop: (() => void) | null = null;
  let cancelled = false;

  void listen<unknown>(PANE_EVENT, (event) => {
    const handover = decodeHandover(event.payload);
    if (handover !== null) handle(handover);
  }).then((unlisten) => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });

  return () => {
    cancelled = true;
    stop?.();
  };
}

function decodeHandover(payload: unknown): PaneHandover | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as { pane?: unknown; content?: unknown; as?: unknown };
  const source = raw.pane as { id?: unknown } | undefined;
  if (typeof source?.id !== "string" || !source.id) return null;

  const pane = decodePaneState(source.id, raw.pane);
  if (pane === null) return null;

  const as = raw.as === "popup" ? "popup" : "tab";
  const content: PaneContent = {};
  const rawContent = raw.content as { draft?: unknown; text?: unknown; caret?: unknown } | undefined;
  if (typeof rawContent?.draft === "string") content.draft = rawContent.draft;
  if (typeof rawContent?.text === "string") content.text = rawContent.text;
  if (typeof rawContent?.caret === "number" && Number.isFinite(rawContent.caret)) {
    content.caret = Math.max(0, Math.floor(rawContent.caret));
  }

  return { pane, content, as };
}

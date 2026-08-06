/**
 * When the snapshot gets written.
 *
 * The whole promise of this app is that a crash costs you a keystroke, so the
 * temptation is to write on every one. That would `fsync` a file per character
 * typed, which is both slow and pointless — the window in which a crash can
 * cost you anything is the gap between writes, and a few hundred milliseconds
 * of that is not something a person can notice losing.
 *
 * So: a short trailing debounce, plus a ceiling on how long continuous typing
 * can defer a write. Without the ceiling, a fast typist never stops being
 * "still typing" and the file never gets written at all — which is exactly the
 * user who has the most to lose.
 *
 * On top of that, anything that looks like the session ending — the window
 * losing focus, being hidden, being closed — forces a write immediately,
 * because those are the moments just before the interesting crashes.
 */

import { session } from "./ipc";

/** Quiet period after the last change before writing. */
const DEBOUNCE_MS = 200;
/** Longest a run of unbroken changes may put a write off. */
const MAX_DEFER_MS = 1000;

let source: (() => string) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let dirtySince = 0;
/** Serialises writes so two `fsync`s are never in flight at once. */
let writing: Promise<void> = Promise.resolve();
let lastWritten: string | null = null;

export function configurePersistence(getSnapshot: () => string): void {
  source = getSnapshot;
}

export function markDirty(): void {
  if (source === null) return;
  const now = Date.now();
  if (dirtySince === 0) dirtySince = now;

  if (timer !== null) clearTimeout(timer);

  // Once changes have been arriving for longer than the ceiling, stop deferring
  // and write on the next tick.
  const wait = now - dirtySince >= MAX_DEFER_MS ? 0 : DEBOUNCE_MS;
  timer = setTimeout(write, wait);
}

/** Write now and resolve when it has actually reached the disk. */
export function flushPersistence(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  return write();
}

function write(): Promise<void> {
  timer = null;
  dirtySince = 0;
  if (source === null) return writing;

  const json = source();
  // Re-saving an unchanged snapshot still costs an `fsync`; a terminal that is
  // only *receiving* output produces a lot of these.
  if (json === lastWritten) return writing;
  lastWritten = json;

  writing = writing
    .catch(() => {})
    .then(() => session.save(json))
    .then(() => {});
  return writing;
}

/**
 * Attach the "the session may be about to end" triggers.
 *
 * Returns a teardown function.
 */
export function installFlushTriggers(): () => void {
  const flush = () => {
    void flushPersistence();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };

  window.addEventListener("blur", flush);
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("blur", flush);
    window.removeEventListener("beforeunload", flush);
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

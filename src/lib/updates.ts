/**
 * What every window knows about updating jterm, and the one loop that checks.
 *
 * The backend holds the truth — see `src-tauri/src/updater.rs` — and announces
 * every change to every window, so the badge in the main window and the panel
 * in the settings window read one store fed by one event rather than each
 * asking on its own and disagreeing about what they found.
 *
 * Checking happens in the main window only (`startUpdateChecks`): once shortly
 * after launch, then every few hours for an app that is left open for weeks.
 * What happens with what it finds is `shouldInstallQuietly`, the one decision
 * here with consequences, which is why it is a pure function with tests.
 */

import { useSyncExternalStore } from "react";

import { getSettings } from "@/state/settings";
import {
  UPDATE_PROGRESS_EVENT,
  UPDATE_STATE_EVENT,
  dialog,
  listen,
  updates as updatesApi,
  type UpdateProgress,
  type UpdateState,
} from "./ipc";

/** Long enough after launch that restoring a session is not competing with it. */
const FIRST_CHECK_MS = 20_000;
/** A release is not an emergency; an app left open for a week should still hear of one. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdatesSnapshot {
  state: UpdateState | null;
  /** The download in flight, while there is one. */
  progress: UpdateProgress | null;
}

let snapshot: UpdatesSnapshot = { state: null, progress: null };
const listeners = new Set<() => void>();

function publish(next: Partial<UpdatesSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function applyState(state: UpdateState | null): void {
  if (state === null) return;
  // A finished or failed install leaves no download behind to show.
  publish({ state, progress: state.installing ? snapshot.progress : null });
}

let listening = false;
function listenOnce(): void {
  if (listening) return;
  listening = true;
  void listen<UpdateState>(UPDATE_STATE_EVENT, applyState);
  void listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (progress) => publish({ progress }));
  // What the backend already knows, for a window opened after a check ran.
  void updatesApi.state().then((state) => {
    if (snapshot.state === null) applyState(state);
  });
}

function subscribe(listener: () => void): () => void {
  listenOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

export function useUpdates(): UpdatesSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether a check's result should be installed without asking.
 *
 * Only an install that needs nothing from the person using the app: a `.deb`
 * wants a password, and on Windows the installer closes jterm, and neither of
 * those should appear out of nowhere. Everything else waits for a button, and
 * so does the restart after a quiet install.
 */
export function shouldInstallQuietly(state: UpdateState | null, autoUpdate: boolean): boolean {
  return (
    autoUpdate &&
    state !== null &&
    state.unsupported === null &&
    state.install === "quiet" &&
    state.available !== null &&
    !state.installing
  );
}

export async function checkForUpdates(): Promise<UpdateState | null> {
  listenOnce();
  const state = await updatesApi.check().catch(() => null);
  applyState(state);
  return state;
}

export async function installUpdate(): Promise<void> {
  if (snapshot.state?.install === "quits") {
    const sure = await dialog.confirm(
      "jterm closes while the installer runs and opens again when it is done. Terminals on tmux keep running; plain shells come back with their screens and an offer to resume what they were running.",
      "Install the update?",
    );
    if (!sure) return;
  }
  // A failure arrives as state, with the reason in it; there is nothing to add.
  applyState(await updatesApi.install().catch(() => null));
}

export async function restartToUpdate(): Promise<void> {
  const sure = await dialog.confirm(
    "Restart jterm to start using the new version? Terminals on tmux keep running. Plain shells restart, and each pane comes back with its screen and an offer to resume what it was running.",
    "Restart to update?",
  );
  if (sure) await updatesApi.restart();
}

/** Check now and then, and install quietly where the setting allows. */
export function startUpdateChecks(): () => void {
  listenOnce();
  const run = async () => {
    const state = await checkForUpdates();
    if (shouldInstallQuietly(state, getSettings().autoUpdate)) await installUpdate();
  };
  const first = window.setTimeout(() => void run(), FIRST_CHECK_MS);
  const every = window.setInterval(() => void run(), CHECK_EVERY_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(every);
  };
}

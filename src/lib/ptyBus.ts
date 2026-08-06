/**
 * One backend listener, fanned out to the panes.
 *
 * Tauri delivers events to every listener registered for a name, so a listener
 * per pane would mean every terminal waking up and discarding a payload for
 * every chunk any other terminal produced. With a few splits open and one of
 * them running a build, that is a lot of wasted work in the middle of the one
 * path that has to stay fast.
 *
 * So there is exactly one listener per event, and a map from pane id to
 * handler. `ready()` exists because attaching a listener is asynchronous:
 * callers must await it *before* spawning a shell, or the first output — which
 * includes the prompt — arrives with nobody listening.
 */

import { PTY_DATA_EVENT, PTY_EXIT_EVENT, listen, type PtyData, type PtyExit } from "./ipc";

type DataHandler = (chunk: string) => void;
type ExitHandler = (code: number | null) => void;

const dataHandlers = new Map<string, DataHandler>();
const exitHandlers = new Map<string, ExitHandler>();

let attaching: Promise<void> | null = null;

export function ready(): Promise<void> {
  if (attaching === null) {
    attaching = Promise.all([
      listen<PtyData>(PTY_DATA_EVENT, (payload) => {
        dataHandlers.get(payload.id)?.(payload.chunk);
      }),
      listen<PtyExit>(PTY_EXIT_EVENT, (payload) => {
        exitHandlers.get(payload.id)?.(payload.code);
      }),
    ]).then(() => {});
  }
  return attaching;
}

export function subscribePty(
  id: string,
  onData: DataHandler,
  onExit: ExitHandler,
): () => void {
  dataHandlers.set(id, onData);
  exitHandlers.set(id, onExit);
  return () => {
    dataHandlers.delete(id);
    exitHandlers.delete(id);
  };
}

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

/**
 * Run one pane's handler without letting it reach the others.
 *
 * The saving in having a single listener is also the risk in it: every pane's
 * output arrives through one callback, so an exception from one pane's handler
 * is thrown inside the delivery path that all of them share. A React error
 * boundary is no help — this is an event callback, not a render — and the
 * failure would be a terminal that silently stopped printing, which is a
 * miserable thing to diagnose because the shell behind it is still running and
 * still producing the output nobody is drawing.
 *
 * Logged rather than swallowed: one bad chunk should cost that chunk, not the
 * pane, and certainly not the pane next to it.
 */
function isolate(what: string, id: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`[jterm] pty ${what} handler for ${id} threw`, error);
  }
}

export function ready(): Promise<void> {
  if (attaching === null) {
    attaching = Promise.all([
      listen<PtyData>(PTY_DATA_EVENT, (payload) => {
        const handler = dataHandlers.get(payload.id);
        if (handler !== undefined) isolate("data", payload.id, () => handler(payload.chunk));
      }),
      listen<PtyExit>(PTY_EXIT_EVENT, (payload) => {
        const handler = exitHandlers.get(payload.id);
        if (handler !== undefined) isolate("exit", payload.id, () => handler(payload.code));
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

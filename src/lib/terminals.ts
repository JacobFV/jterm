/**
 * A handle on each live terminal, for the few things that have to reach into
 * one from outside its component.
 *
 * Copy, paste and "send EOF" are all triggered by a global keyboard shortcut,
 * which has no idea which React component owns the focused pane — and cannot
 * find out without threading a callback through every layer between. A tiny
 * registry keyed by pane id is the smaller cost.
 *
 * Copy and paste in particular cannot be left to the browser: xterm.js draws to
 * a canvas, so there is no DOM selection for a native copy to pick up, and the
 * text has to be asked for explicitly.
 */

export interface TerminalHandle {
  /** The selected text, or an empty string. */
  getSelection: () => string;
  /** Send text to the shell as though it had been pasted. */
  paste: (text: string) => void;
  /** Send raw bytes to the shell. */
  send: (data: string) => void;
  focus: () => void;
}

const handles = new Map<string, TerminalHandle>();

export function registerTerminal(paneId: string, handle: TerminalHandle): () => void {
  handles.set(paneId, handle);
  return () => {
    // Guarded: a pane that has already been replaced must not have its
    // successor's handle removed by a late cleanup.
    if (handles.get(paneId) === handle) handles.delete(paneId);
  };
}

export function terminalHandle(paneId: string): TerminalHandle | null {
  return handles.get(paneId) ?? null;
}

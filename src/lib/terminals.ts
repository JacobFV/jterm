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
  /** The last `lines` lines of what the terminal holds, as plain text. */
  readText: (lines: number) => string;
}

/** The part of an xterm buffer `tailText` reads, so it can be tested in node. */
export interface BufferLike {
  length: number;
  getLine(index: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * The end of a terminal's buffer as text, the way a person would copy it.
 *
 * A line xterm wrapped because the pane was narrow is one line, not two — an
 * agent reading a build error should not find it broken at column 80 — so
 * wrapped rows are joined back onto the row they continue. Trailing blank rows
 * are dropped: below the prompt of a quiet shell is an empty screen, and that is
 * not something anyone asked to read.
 */
export function tailText(buffer: BufferLike, lines: number): string {
  const logical: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const row = buffer.getLine(index);
    if (row === undefined) continue;
    const text = row.translateToString(true);
    if (row.isWrapped && logical.length > 0) logical[logical.length - 1] += text;
    else logical.push(text);
  }
  while (logical.length > 0 && logical[logical.length - 1].trim() === "") logical.pop();
  return logical.slice(-Math.max(1, lines)).join("\n");
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

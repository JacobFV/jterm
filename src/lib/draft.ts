/**
 * Shadowing the command you have typed but not yet run.
 *
 * The problem: the line at a shell prompt belongs to the *shell*, not to the
 * terminal. Readline holds it in the child process's memory, and a terminal
 * emulator only ever sees the echoed pixels. There is nothing to ask for it.
 *
 * So this reconstructs the line from the other side — from the keystrokes on
 * their way in. Every editing key readline understands is applied to a local
 * copy, and `Enter` clears it because the line is now the shell's problem. The
 * result is a plain string that can be written to disk on a timer and typed
 * back at a fresh prompt after a crash.
 *
 * Where it cannot follow, it says so rather than guessing. Tab completion and
 * history recall rewrite the line inside the shell with no corresponding
 * keystrokes, so both mark the draft `trusted: false`. Nothing here is ever
 * replayed with a newline attached, so even a wrong guess can only ever put
 * text on screen for you to look at — it can never run anything.
 */

export interface Draft {
  text: string;
  /** Offset within `text`, mirroring readline's point. */
  caret: number;
  /** False once the shell has redrawn the line in a way we cannot see. */
  trusted: boolean;
}

/** A prompt line is short; past this, something upstream is wrong. */
export const MAX_DRAFT = 8 * 1024;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function emptyDraft(): Draft {
  return { text: "", caret: 0, trusted: true };
}

export function draftFrom(text: string): Draft {
  return { text, caret: text.length, trusted: true };
}

/**
 * Apply everything the user just typed.
 *
 * `data` is exactly what goes to the shell, so this is the same byte stream
 * readline is about to interpret — which is what makes the mirror possible.
 */
export function applyInput(draft: Draft, data: string): Draft {
  let { text, caret, trusted } = draft;

  const insert = (value: string) => {
    if (text.length + value.length > MAX_DRAFT) {
      trusted = false;
      return;
    }
    text = text.slice(0, caret) + value + text.slice(caret);
    caret += value.length;
  };
  const submit = () => {
    text = "";
    caret = 0;
    trusted = true;
  };
  const desync = () => {
    // The shell replaced the line with something we never saw. Keeping the old
    // text would be worse than admitting we lost it.
    text = "";
    caret = 0;
    trusted = false;
  };

  let index = 0;
  while (index < data.length) {
    // A paste arrives wrapped in these when the shell has bracketed paste on.
    // The contents are data, not commands — readline inserts them literally,
    // newlines and all, so this does too.
    if (data.startsWith(PASTE_START, index)) {
      const end = data.indexOf(PASTE_END, index + PASTE_START.length);
      const stop = end === -1 ? data.length : end;
      insert(data.slice(index + PASTE_START.length, stop));
      index = end === -1 ? data.length : end + PASTE_END.length;
      continue;
    }

    const char = data[index];

    if (char === "\x1b") {
      const sequence = readEscape(data, index);
      index += sequence.length;
      switch (sequence) {
        case "\x1b[C":
        case "\x1bOC":
          caret = Math.min(text.length, caret + 1);
          break;
        case "\x1b[D":
        case "\x1bOD":
          caret = Math.max(0, caret - 1);
          break;
        case "\x1b[H":
        case "\x1bOH":
        case "\x1b[1~":
          caret = 0;
          break;
        case "\x1b[F":
        case "\x1bOF":
        case "\x1b[4~":
          caret = text.length;
          break;
        case "\x1b[3~":
          text = text.slice(0, caret) + text.slice(caret + 1);
          break;
        case "\x1bb":
          caret = wordStart(text, caret);
          break;
        case "\x1bf":
          caret = wordEnd(text, caret);
          break;
        case "\x1b\x7f": {
          const start = wordStart(text, caret);
          text = text.slice(0, start) + text.slice(caret);
          caret = start;
          break;
        }
        case "\x1b[A":
        case "\x1bOA":
        case "\x1b[B":
        case "\x1bOB":
          // History recall. Whatever is on the line now came from the shell.
          desync();
          break;
        default:
          // Any other escape sequence leaves the line alone as far as we know,
          // and is dropped rather than typed in as its literal characters.
          break;
      }
      continue;
    }

    index += 1;

    switch (char) {
      case "\r":
      case "\n":
        submit();
        break;
      case "\x7f":
      case "\x08":
        if (caret > 0) {
          text = text.slice(0, caret - 1) + text.slice(caret);
          caret -= 1;
        }
        break;
      case "\x01": // Ctrl-A
        caret = 0;
        break;
      case "\x05": // Ctrl-E
        caret = text.length;
        break;
      case "\x02": // Ctrl-B
        caret = Math.max(0, caret - 1);
        break;
      case "\x06": // Ctrl-F
        caret = Math.min(text.length, caret + 1);
        break;
      case "\x04": // Ctrl-D deletes forward when the line is not empty.
        text = text.slice(0, caret) + text.slice(caret + 1);
        break;
      case "\x03": // Ctrl-C abandons the line.
        submit();
        break;
      case "\x15": // Ctrl-U discards back to the start.
        text = text.slice(caret);
        caret = 0;
        break;
      case "\x0b": // Ctrl-K discards to the end.
        text = text.slice(0, caret);
        break;
      case "\x17": { // Ctrl-W discards the word behind the caret.
        const start = wordStart(text, caret);
        text = text.slice(0, start) + text.slice(caret);
        caret = start;
        break;
      }
      case "\x0c": // Ctrl-L repaints the screen; the line is untouched.
        break;
      case "\x12": // Ctrl-R hands the line over to history search.
        desync();
        break;
      case "\t":
        // Completion may rewrite the line, and we will not see it happen.
        trusted = false;
        break;
      default:
        // Everything else printable, including anything above ASCII.
        if (char >= " " && char !== "\x7f") insert(char);
        break;
    }
  }

  return { text, caret: Math.max(0, Math.min(text.length, caret)), trusted };
}

/** Consume one escape sequence starting at `index`, returning it whole. */
function readEscape(data: string, index: number): string {
  const next = data[index + 1];
  if (next === "[") {
    let end = index + 2;
    // CSI runs until a byte in the final range @ through ~.
    while (end < data.length && !(data[end] >= "@" && data[end] <= "~")) end += 1;
    return data.slice(index, Math.min(end + 1, data.length));
  }
  if (next === "O") return data.slice(index, index + 3);
  return data.slice(index, index + 2);
}

function wordStart(text: string, caret: number): number {
  let index = caret;
  while (index > 0 && /\s/.test(text[index - 1])) index -= 1;
  while (index > 0 && !/\s/.test(text[index - 1])) index -= 1;
  return index;
}

function wordEnd(text: string, caret: number): number {
  let index = caret;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  while (index < text.length && !/\s/.test(text[index])) index += 1;
  return index;
}

/**
 * The bytes to send so a saved draft reappears at a fresh prompt.
 *
 * Two rules, and both are about never running anything by accident:
 *
 *   - Control characters are stripped. The draft is written to a file in a
 *     directory the user can edit, and a stray carriage return in that file
 *     would otherwise become a command this app pressed Enter on.
 *   - A draft that legitimately contains newlines — pasted, once — goes back
 *     wrapped in bracketed paste, which is the one way to put a newline into
 *     readline's buffer without submitting it.
 *
 * Returns an empty string when there is nothing safe to send.
 */
export function replayBytes(text: string): string {
  if (!text) return "";

  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "").slice(0, MAX_DRAFT);
  if (!cleaned) return "";

  return cleaned.includes("\n") ? PASTE_START + cleaned + PASTE_END : cleaned;
}

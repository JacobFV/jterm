/**
 * Reading the shell's out-of-band reports out of its output stream.
 *
 * Shells announce two things a terminal wants to know, as escape sequences
 * mixed into ordinary output: the window title (OSC 0 and OSC 2) and the
 * current working directory (OSC 7). The second is how a tab can reopen where
 * it was after a restart, on every platform — Linux could read `/proc`, but
 * macOS and Windows cannot, and this works the same everywhere the shell
 * cooperates. macOS's stock `/etc/zshrc` and most Linux distributions' bash and
 * zsh profiles emit OSC 7 already; PowerShell does not, which is why a missing
 * result is an ordinary outcome and not an error.
 *
 * The sequences arrive split across reads as often as not, so `scan` is given
 * a carry from the previous chunk and hands back a new one.
 */

/** How much of the previous chunk is re-examined. Comfortably past any path. */
const CARRY = 1024;

// OSC 7 is `ESC ] 7 ; file://<host><path>` then BEL or ST.
const CWD_PATTERN = /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// OSC 0 sets icon name and title; OSC 2 sets the title alone.
const TITLE_PATTERN = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export interface OscScan {
  cwd?: string;
  title?: string;
  /** Pass back into the next call so a split sequence is still seen. */
  carry: string;
}

export function scanOsc(chunk: string, carry = ""): OscScan {
  const text = carry + chunk;
  const result: OscScan = { carry: text.slice(-CARRY) };

  const cwd = lastMatch(CWD_PATTERN, text);
  if (cwd !== null) {
    // Paths are percent-encoded in the URL, and a directory with a space in it
    // is common enough that skipping this would be a bug people hit.
    try {
      result.cwd = decodeURIComponent(cwd);
    } catch {
      result.cwd = cwd;
    }
  }

  const title = lastMatch(TITLE_PATTERN, text);
  if (title !== null) result.title = title.slice(0, 200);

  return result;
}

/**
 * The final match only.
 *
 * Because each call re-scans the tail of the previous chunk, an older report
 * can reappear alongside a newer one. Taking the last keeps the newest, which
 * is the only one that is still true.
 */
function lastMatch(pattern: RegExp, text: string): string | null {
  pattern.lastIndex = 0;
  let found: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found = match[1];
  return found;
}

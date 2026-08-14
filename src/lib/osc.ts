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

/**
 * OSC 133, the "semantic prompt" markers: `A` before the prompt, `B` before the
 * user's input, `C` when a command starts running, `D` when it finishes —
 * `D` optionally carrying the exit status.
 *
 * This is the only way a terminal can know where one command ends and the next
 * begins. Everything jterm does by watching keystrokes — the mirrored draft
 * line, the recorded command — cannot tell a shell's prompt from a REPL's,
 * because from out here they are the same bytes. These markers are the shell
 * saying so out loud.
 *
 * jterm only *listens*. Plenty of setups already emit them (starship,
 * bash-preexec, several distributions' stock profiles, zsh with the right
 * hooks), and for those it lights up with nothing installed. It will not write
 * to anyone's rc files to arrange it.
 */
const PROMPT_PATTERN = /\x1b\]133;([A-D])([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** What the shell said happened, in the order it said it. */
export interface PromptMark {
  kind: "prompt" | "input" | "running" | "done";
  /** Only on `done`, and only when the shell bothered to report one. */
  code?: number;
}

export interface OscScan {
  cwd?: string;
  title?: string;
  /**
   * Every OSC 133 marker that *completed* in this chunk, oldest first.
   *
   * A list rather than the latest, because unlike a title or a directory these
   * are events: one chunk can easily carry the end of one command and the
   * prompt for the next, and collapsing them would lose the command.
   */
  marks: PromptMark[];
  /** Pass back into the next call so a split sequence is still seen. */
  carry: string;
}

export function scanOsc(chunk: string, carry = ""): OscScan {
  const text = carry + chunk;
  const result: OscScan = { carry: text.slice(-CARRY), marks: promptMarks(text, carry.length) };

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
 * The markers that finished inside this chunk.
 *
 * `carried` is how much of `text` is the tail of the previous call, and the
 * whole subtlety lives there. That region was already scanned last time, so a
 * marker lying entirely within it has already been reported — reporting it
 * again would record one command as two. But a marker that *starts* in the
 * carry and *ends* in the new bytes was incomplete last time and was not
 * reported, so it must be now.
 *
 * The test is therefore where the marker ends, not where it begins.
 */
function promptMarks(text: string, carried: number): PromptMark[] {
  PROMPT_PATTERN.lastIndex = 0;
  const marks: PromptMark[] = [];
  let match: RegExpExecArray | null;
  while ((match = PROMPT_PATTERN.exec(text)) !== null) {
    if (match.index + match[0].length <= carried) continue;

    const letter = match[1];
    const kind =
      letter === "A"
        ? "prompt"
        : letter === "B"
          ? "input"
          : letter === "C"
            ? "running"
            : "done";

    const mark: PromptMark = { kind };
    if (kind === "done") {
      // `D` carries the status as `;<n>`, and everything after that is other
      // shells' extra parameters. A `D` with no status at all is legal and
      // means the shell chose not to say — which is not the same as zero.
      const code = /^;(\d+)/.exec(match[2]);
      if (code !== null) mark.code = Number(code[1]);
    }
    marks.push(mark);
  }
  return marks;
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

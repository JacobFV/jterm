/**
 * Replaying a recorded session into a fresh terminal.
 *
 * The scrollback file is the raw byte stream the last session's programs
 * wrote — not their text but everything they said, escape sequences and all.
 * That is what lets a restored pane come back looking like the one that died.
 * It is also why writing it back is not simply printing: xterm.js parses those
 * bytes exactly as it did the first time, and two kinds of them have effects
 * that outlive the picture.
 *
 * **Questions.** A full-screen program asks the terminal things — what are you
 * (`CSI c`), what colour is your background (`OSC 11 ; ?`), where is the cursor
 * (`CSI 6 n`). The answer does not go back to the program that asked; it goes
 * up the pty, indistinguishable from typing, and whatever is reading gets it.
 * Replay the log and the questions are asked a second time, but the program
 * that asked them is long gone, so the answers land at the prompt of a
 * brand-new shell that never asked. That is where a restored pane's
 * `^[[?1;2c` and `^[]11;rgb:0000/0000/0000^[\` come from, sitting in the
 * command line as if typed. `TerminalPane` deals with those by not forwarding
 * anything the terminal says while a replay is being parsed.
 *
 * **Modes.** `CSI ? 1004 h` turns on focus reporting, `CSI ? 1000 h` mouse
 * tracking, `CSI ? 2004 h` bracketed paste, `CSI ? 1049 h` the alternate
 * screen. Programs turn these back off on the way out — but a session that
 * ended because the machine did never reached its way out, so its log is a
 * list of modes switched on and never off. Replayed, they are switched on in
 * the new terminal, and the shell that starts there inherits a terminal it
 * never configured: focus events arriving as input every time the window is
 * clicked away from, a cursor it never hid, and — worst of the set — the
 * alternate screen, which has no scrollback and which suspends draft tracking
 * for as long as it is active.
 *
 * `RESTORE_RESET` is what closes that second hole: written straight after the
 * replay, it puts the emulator back into the state a terminal starts in. It is
 * deliberately not `RIS` (`ESC c`), which would also clear the screen and so
 * erase the very thing the replay just drew.
 */

/**
 * Every mode a replayed log can leave switched on, switched off again.
 *
 * Ordered roughly as a terminal cares about it: leave the alternate screen
 * first, so the rest applies to the buffer the shell will actually use.
 */
export const RESTORE_RESET = [
  // Bracketing the whole reset, because two of the sequences inside it move
  // the cursor as a documented side effect and one of them is unavoidable:
  // `CSI r` homes the cursor, and leaving the alternate screen restores the
  // position saved by the `CSI ? 1049 h` that a crashed log never wrote.
  // Without the pair, the cursor ends up at the top of the screen and the
  // banner is drawn over the last lines of the replay — the newest and most
  // interesting part of it.
  "\x1b7",
  "\x1b[?1049l", // alternate screen off — back to the buffer with the scrollback
  "\x1b[?1004l", // focus reporting off: no more `^[[I` / `^[[O` at the prompt
  "\x1b[?2004l", // bracketed paste off
  "\x1b[?1000l", // mouse: click tracking
  "\x1b[?1002l", //        button-event tracking
  "\x1b[?1003l", //        any-event tracking
  "\x1b[?1005l", //        UTF-8 coordinates
  "\x1b[?1006l", //        SGR coordinates
  "\x1b[?1015l", //        urxvt coordinates
  // Sixel display mode, which a program that drew a picture without wanting the
  // cursor moved may have left on. Set, an image paints from the top left of
  // the viewport and the cursor stays put — so a replayed log that turned it on
  // and died would stack every later picture in one corner.
  "\x1b[?80l",
  "\x1b[?1l", // cursor keys back to normal, not application
  "\x1b>", // keypad likewise
  "\x1b[?5l", // screen not reversed
  "\x1b[?6l", // origin at the screen, not the scroll region
  "\x1b[?7h", // autowrap on, which is where a terminal starts
  "\x1b[4l", // replace, not insert
  "\x1b[r", // scroll region back to the full height — and cursor to the home
  "\x1b(B", // G0 back to ASCII, in case of a line-drawing charset
  "\x1b[?25h", // cursor visible
  "\x1b8", // back to where the replay left off, undoing the moves above
  "\x1b[m", // default colours and attributes — after the restore, which sets them
].join("");

/**
 * The line drawn under a replayed log to say where it ends.
 *
 * `adopted` distinguishes the two ways a pane can come back with history
 * behind it: the shell survived and this is the same session continuing, or it
 * did not and this is a record of one that is over. The wording is the only
 * place a user is told which.
 */
export function restoreBanner(adopted: boolean): string {
  const label = adopted ? "── reconnected ──" : "── session restored ──";
  return `${RESTORE_RESET}\r\n\x1b[2m${label}\x1b[0m\r\n`;
}

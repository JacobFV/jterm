import { describe, expect, it } from "vitest";

import { RESTORE_RESET, restoreBanner } from "@/lib/scrollback";

/**
 * The modes a dying session is most likely to have left switched on, and what
 * each one does to the shell that inherits it. The list is the point of the
 * reset: a session that ends in a crash ends mid-program, and every one of
 * these is something a program turns on at startup and off on the way out.
 */
const MUST_CLEAR = [
  ["\x1b[?1049l", "alternate screen — no scrollback, and draft tracking off"],
  ["\x1b[?1004l", "focus reporting — `^[[I` and `^[[O` typed at the prompt"],
  ["\x1b[?2004l", "bracketed paste — `^[[200~` wrapped around every paste"],
  ["\x1b[?1000l", "mouse click tracking"],
  ["\x1b[?1002l", "mouse button-event tracking"],
  ["\x1b[?1003l", "mouse any-event tracking"],
  ["\x1b[?1006l", "SGR mouse coordinates"],
  ["\x1b[?25h", "hidden cursor"],
  ["\x1b[?1l", "application cursor keys — arrows send `ESC O A`"],
  ["\x1b[r", "a scroll region the size of the dead program's window"],
] as const;

describe("RESTORE_RESET", () => {
  for (const [sequence, why] of MUST_CLEAR) {
    it(`clears ${why}`, () => {
      expect(RESTORE_RESET).toContain(sequence);
    });
  }

  it("leaves the alternate screen before anything else", () => {
    // The rest of the reset is about the buffer the shell will use, so it has
    // to be the normal buffer by the time the rest arrives.
    expect(RESTORE_RESET.indexOf("\x1b[?1049l")).toBe("\x1b7".length);
  });

  it("puts the cursor back where the replay left it", () => {
    // `CSI r` homes the cursor and leaving the alternate screen restores a
    // position a crashed log never saved. Either one alone would put the
    // banner over the end of the replay, so the whole reset is bracketed.
    expect(RESTORE_RESET.indexOf("\x1b7")).toBe(0);
    expect(RESTORE_RESET).toContain("\x1b8");
    for (const moves of ["\x1b[?1049l", "\x1b[r", "\x1b[?6l"]) {
      expect(RESTORE_RESET.indexOf(moves)).toBeGreaterThan(RESTORE_RESET.indexOf("\x1b7"));
      expect(RESTORE_RESET.indexOf(moves)).toBeLessThan(RESTORE_RESET.indexOf("\x1b8"));
    }
  });

  it("resets colours after restoring the cursor, not before", () => {
    // A cursor restore brings the saved attributes back with the saved
    // position, so a colour reset that ran first would simply be undone.
    expect(RESTORE_RESET.indexOf("\x1b[m")).toBeGreaterThan(RESTORE_RESET.indexOf("\x1b8"));
  });

  it("does not clear the screen", () => {
    // RIS would reset every mode in one sequence and is the obvious shortcut.
    // It also erases the buffer, which is the replayed session — the whole
    // reason any of this runs.
    expect(RESTORE_RESET).not.toContain("\x1bc");
    expect(RESTORE_RESET).not.toContain("\x1b[2J");
    expect(RESTORE_RESET).not.toContain("\x1b[3J");
  });

  it("asks the terminal nothing", () => {
    // A reset that provoked an answer would put that answer up the pty and
    // into the shell's command line — precisely the bug next door.
    expect(RESTORE_RESET).not.toMatch(/\x1b\[[?>=]?[0-9;]*[cn]/);
    expect(RESTORE_RESET).not.toContain("?\x1b\\");
  });
});

describe("restoreBanner", () => {
  it("says the session is over when the shell did not survive", () => {
    expect(restoreBanner(false)).toContain("session restored");
  });

  it("says it is the same session when the shell did", () => {
    expect(restoreBanner(true)).toContain("reconnected");
  });

  it("resets before it draws, so the log cannot colour the banner", () => {
    const banner = restoreBanner(false);
    expect(banner.startsWith(RESTORE_RESET)).toBe(true);
  });

  it("starts on a line of its own and ends on one", () => {
    // The log almost never ends in a newline: it ends wherever the shell was.
    expect(restoreBanner(true)).toMatch(/\r\n.*\r\n$/s);
  });
});

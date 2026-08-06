import { describe, expect, it } from "vitest";
import { applyInput, emptyDraft, replayBytes, type Draft } from "./draft";

/** Type a whole string in one go, as xterm delivers it. */
function type(data: string, from: Draft = emptyDraft()): Draft {
  return applyInput(from, data);
}

describe("applyInput", () => {
  it("accumulates ordinary typing", () => {
    expect(type("git status")).toEqual({ text: "git status", caret: 10, trusted: true });
  });

  it("clears the line once it is submitted", () => {
    expect(type("ls -la\r")).toEqual({ text: "", caret: 0, trusted: true });
  });

  it("keeps only what follows the last Enter", () => {
    expect(type("one\rtwo").text).toBe("two");
  });

  it("applies backspace", () => {
    expect(type("cdd\x7f").text).toBe("cd");
  });

  it("inserts at the caret after arrow keys", () => {
    const draft = type("echo hi\x1b[D\x1b[D");
    expect(draft.caret).toBe(5);
    expect(applyInput(draft, "X").text).toBe("echo Xhi");
  });

  it("treats Ctrl-A and Ctrl-E as line ends", () => {
    expect(applyInput(type("world"), "\x01hello ").text).toBe("hello world");
    expect(applyInput(type("ab\x01"), "\x05c").text).toBe("abc");
  });

  it("discards to the start on Ctrl-U and to the end on Ctrl-K", () => {
    expect(type("rm -rf /\x15").text).toBe("");
    expect(type("keep drop\x1b[D\x1b[D\x1b[D\x1b[D\x0b").text).toBe("keep ");
  });

  it("deletes a word on Ctrl-W", () => {
    expect(type("git commit --amend\x17").text).toBe("git commit ");
  });

  it("abandons the line on Ctrl-C", () => {
    expect(type("half typed\x03")).toEqual({ text: "", caret: 0, trusted: true });
  });

  it("leaves the line alone when the screen is repainted", () => {
    expect(type("still here\x0c").text).toBe("still here");
  });

  it("never types an escape sequence in as literal characters", () => {
    // A bare cursor-position report or similar must not become "[6n".
    expect(type("a\x1b[6nb").text).toBe("ab");
  });

  it("stops trusting itself after tab completion", () => {
    const draft = type("cd Doc\t");
    expect(draft.trusted).toBe(false);
    // The text is still the best guess available, and is kept.
    expect(draft.text).toBe("cd Doc");
  });

  it("gives up the line entirely on history recall", () => {
    const draft = type("partial\x1b[A");
    expect(draft).toEqual({ text: "", caret: 0, trusted: false });
  });

  it("gives up the line on reverse search", () => {
    expect(type("grep\x12").trusted).toBe(false);
  });

  it("takes a bracketed paste literally, newlines included", () => {
    expect(type("\x1b[200~one\ntwo\x1b[201~").text).toBe("one\ntwo");
  });

  it("handles a paste whose end marker has not arrived yet", () => {
    expect(type("\x1b[200~partial").text).toBe("partial");
  });

  it("keeps multi-byte characters whole", () => {
    expect(type("echo héllo 😀").text).toBe("echo héllo 😀");
  });

  it("refuses to grow without bound", () => {
    const draft = type("x".repeat(9000));
    expect(draft.text.length).toBeLessThanOrEqual(8 * 1024);
    expect(draft.trusted).toBe(false);
  });
});

describe("replayBytes", () => {
  it("sends an ordinary draft as-is", () => {
    expect(replayBytes("git status")).toBe("git status");
  });

  it("sends nothing for an empty draft", () => {
    expect(replayBytes("")).toBe("");
  });

  it("strips a carriage return rather than pressing Enter with it", () => {
    // The snapshot file is user-writable; this is the case that must not run.
    expect(replayBytes("rm -rf /\rwhoami")).toBe("rm -rf /whoami");
    expect(replayBytes("rm -rf /\r")).not.toContain("\r");
  });

  it("strips every other control character too", () => {
    expect(replayBytes("a\x00b\x1bc\x07d")).toBe("abcd");
  });

  it("wraps a genuinely multi-line draft in bracketed paste", () => {
    const bytes = replayBytes("for x in a b\ndo echo $x");
    expect(bytes.startsWith("\x1b[200~")).toBe(true);
    expect(bytes.endsWith("\x1b[201~")).toBe(true);
    // Still no carriage return: readline inserts, it does not submit.
    expect(bytes).not.toContain("\r");
  });

  it("sends nothing when a draft is only control characters", () => {
    expect(replayBytes("\r\r\r")).toBe("");
  });
});

describe("round trip", () => {
  it("what was typed is what comes back", () => {
    const draft = type("docker compose up -d --build");
    expect(replayBytes(draft.text)).toBe("docker compose up -d --build");
  });
});

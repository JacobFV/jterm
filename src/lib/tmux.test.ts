import { beforeEach, describe, expect, it, vi } from "vitest";

const killSession = vi.fn();

// Only the one call this file makes; the rest of the IPC surface is not reached
// by anything under test here.
vi.mock("./ipc", () => ({
  tmuxControl: { paneCommand: vi.fn(async () => false) },
  tmux: {
    available: vi.fn(async () => false),
    sessions: vi.fn(async () => []),
    paneCommand: vi.fn(async () => false),
    killSession,
  },
}));

const {
  disposeSession,
  isOwnSession,
  isTmuxAction,
  looksLikeOwnSession,
  sessionNameFor,
} = await import("./tmux");

beforeEach(() => {
  killSession.mockClear();
});

describe("session names", () => {
  it("derives one name per pane, short enough to live in a status line", () => {
    const name = sessionNameFor("3f2a9c1b7d4e5f6a01");
    expect(name).toBe("jterm-3f2a9c1b");
    // The pane id is 18 hex characters; carrying all of it into every
    // `tmux ls` the user runs is noise.
    expect(name.length).toBeLessThan(20);
  });

  it("gives the same pane the same name every time", () => {
    // This is what lets a restored pane find the session it left behind even if
    // the snapshot lost the field.
    expect(sessionNameFor("abc123def456")).toBe(sessionNameFor("abc123def456"));
  });

  it("tells jterm's own session for a pane from any other", () => {
    const paneId = "abc123def456";
    expect(isOwnSession(paneId, sessionNameFor(paneId))).toBe(true);
    expect(isOwnSession(paneId, "work")).toBe(false);
    // Another pane's jterm session is still not this pane's to end.
    expect(isOwnSession(paneId, sessionNameFor("999999999999"))).toBe(false);
  });

  it("labels a jterm-shaped name without claiming ownership of it", () => {
    expect(looksLikeOwnSession("jterm-abc123")).toBe(true);
    expect(looksLikeOwnSession("work")).toBe(false);
  });
});

describe("disposeSession", () => {
  it("ends the session jterm made for the pane being closed", () => {
    const paneId = "abc123def456";
    disposeSession(paneId, sessionNameFor(paneId));
    expect(killSession).toHaveBeenCalledWith(sessionNameFor(paneId));
  });

  it("leaves a session the user made alone", () => {
    // Closing a pane that was merely looking at someone's long-running `work`
    // must not destroy it — the pane detaches and that is all.
    disposeSession("abc123def456", "work");
    expect(killSession).not.toHaveBeenCalled();
  });

  it("does nothing for a pane that was never in tmux", () => {
    disposeSession("abc123def456", undefined);
    expect(killSession).not.toHaveBeenCalled();
  });

  it("will not end another pane's session even though jterm made it", () => {
    disposeSession("abc123def456", sessionNameFor("999999999999"));
    expect(killSession).not.toHaveBeenCalled();
  });
});

describe("which shortcuts tmux takes", () => {
  it("takes the ones that are about where panes are", () => {
    for (const id of [
      "pane.splitRight",
      "pane.splitDown",
      "pane.zoom",
      "pane.focusLeft",
      "pane.focusRight",
      "pane.focusUp",
      "pane.focusDown",
      "pane.growLeft",
      "pane.growRight",
      "pane.growUp",
      "pane.growDown",
    ] as const) {
      expect(isTmuxAction(id), id).toBe(true);
    }
  });

  it("leaves closing a pane to jterm", () => {
    // Routed to `kill-pane`, a session with one pane left would be destroyed
    // and the jterm pane would stay behind showing a dead shell — a keystroke
    // that does not close the thing it is aimed at.
    expect(isTmuxAction("pane.close")).toBe(false);
  });

  it("never takes a tab shortcut", () => {
    // A jterm tab is a window of the app and has no tmux counterpart; opening a
    // tmux window on Mod+T would make the tab strip disagree with the app.
    for (const id of ["tab.new", "tab.next", "tab.prev", "tab.byIndex"] as const) {
      expect(isTmuxAction(id), id).toBe(false);
    }
  });

  it("leaves the terminal's own keys alone", () => {
    for (const id of ["terminal.eof", "edit.copy", "edit.paste"] as const) {
      expect(isTmuxAction(id), id).toBe(false);
    }
  });
});

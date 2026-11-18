import { describe, expect, it } from "vitest";

import {
  REEL_SOURCES,
  SETUP_VERSION,
  decodeResume,
  reelOrder,
  shouldOfferSetup,
  stepsFor,
  tmuxOffer,
} from "./setup";

describe("shouldOfferSetup", () => {
  it("offers itself until the current version has been seen", () => {
    expect(shouldOfferSetup(0)).toBe(true);
    expect(shouldOfferSetup(SETUP_VERSION - 1)).toBe(true);
    expect(shouldOfferSetup(SETUP_VERSION)).toBe(false);
    // A settings file from a later jterm, opened by an older one.
    expect(shouldOfferSetup(SETUP_VERSION + 1)).toBe(false);
  });
});

describe("stepsFor", () => {
  it("leaves the tmux step out only where there is no tmux to have", () => {
    const ids = (platform: "macos" | "linux" | "windows") => stepsFor(platform).map((s) => s.id);
    expect(ids("macos")).toContain("tmux");
    expect(ids("linux")).toContain("tmux");
    expect(ids("windows")).not.toContain("tmux");
    expect(ids("windows")[0]).toBe("welcome");
  });
});

describe("tmuxOffer", () => {
  const none = { tmux: null, brew: null };

  it("says where tmux is when it is there", () => {
    expect(tmuxOffer({ ...none, tmux: "/opt/homebrew/bin/tmux" }, "macos")).toEqual({
      kind: "ready",
      path: "/opt/homebrew/bin/tmux",
    });
  });

  it("offers Homebrew's install on a Mac that has Homebrew", () => {
    expect(tmuxOffer({ ...none, brew: "/opt/homebrew/bin/brew" }, "macos")).toEqual({
      kind: "install",
      command: "brew install tmux",
    });
  });

  it("points at Homebrew rather than typing its installer", () => {
    expect(tmuxOffer(none, "macos").kind).toBe("homebrew");
  });

  it("lists package managers on Linux instead of guessing one", () => {
    const offer = tmuxOffer(none, "linux");
    expect(offer.kind).toBe("manual");
  });

  it("offers nothing on Windows, even if something answered", () => {
    expect(tmuxOffer({ tmux: "C:\\tmux.exe", brew: null }, "windows").kind).toBe("unsupported");
  });
});

describe("decodeResume", () => {
  const steps = stepsFor("macos");

  it("comes back to the step that asked for the restart", () => {
    expect(steps[decodeResume("updates", steps)].id).toBe("updates");
  });

  it("starts at the beginning for nothing, junk, or a step this machine lacks", () => {
    expect(decodeResume(null, steps)).toBe(0);
    expect(decodeResume("not-a-step", steps)).toBe(0);
    expect(decodeResume("tmux", stepsFor("windows"))).toBe(0);
  });
});

describe("reelOrder", () => {
  const mp4 = REEL_SOURCES[0];
  const webm = REEL_SOURCES[1];

  it("skips what the webview says it cannot play", () => {
    // WebKitGTK on a machine with no H.264 decoder installed.
    expect(reelOrder((type) => (type.includes("vp9") ? "probably" : ""))).toEqual([webm]);
  });

  it("puts a confident answer ahead of a hesitant one", () => {
    expect(reelOrder((type) => (type.includes("vp9") ? "probably" : "maybe"))).toEqual([webm, mp4]);
  });

  it("keeps the listed order when the answers tie", () => {
    expect(reelOrder(() => "probably")).toEqual([mp4, webm]);
  });

  it("leaves nothing to try when nothing plays, so the poster stays up", () => {
    expect(reelOrder(() => "")).toEqual([]);
  });
});

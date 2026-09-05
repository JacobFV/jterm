import { describe, expect, it } from "vitest";

import { decodeRecents, shortPath } from "./recents";

describe("decodeRecents", () => {
  it("reads back what was stored", () => {
    const stored = JSON.stringify([
      { key: "file:/tmp/a.md", kind: "file", at: "2026-09-05T10:00:00Z", label: "a.md", path: "/tmp/a.md" },
      {
        key: "session:terminal:claude:/w",
        kind: "session",
        at: "2026-09-05T09:00:00Z",
        label: "claude",
        pane: "terminal",
        cwd: "/w",
        command: "claude",
        profile: "claude",
      },
    ]);

    const entries = decodeRecents(stored);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("file");
    expect(entries[1]).toMatchObject({ kind: "session", pane: "terminal", command: "claude" });
  });

  it("drops an entry that could not become a pane, and keeps the rest", () => {
    const stored = JSON.stringify([
      { kind: "file", label: "no key", path: "/tmp/a" },
      { key: "k1", kind: "file", label: "no path" },
      { key: "k2", kind: "session", label: "no such pane kind", pane: "wormhole" },
      { key: "k3", kind: "file", label: "fine", path: "/tmp/b" },
    ]);

    const entries = decodeRecents(stored);
    expect(entries.map((entry) => entry.key)).toEqual(["k3"]);
  });

  it("treats a file that is not a list as an empty one", () => {
    expect(decodeRecents(null)).toEqual([]);
    expect(decodeRecents("")).toEqual([]);
    expect(decodeRecents("not json")).toEqual([]);
    expect(decodeRecents('{"entries":[]}')).toEqual([]);
  });

  it("caps a command, which is a string that gets typed at a prompt", () => {
    const stored = JSON.stringify([
      {
        key: "k",
        kind: "session",
        label: "big",
        pane: "terminal",
        command: "x".repeat(5000),
      },
    ]);
    const entry = decodeRecents(stored)[0];
    expect(entry.kind === "session" && entry.command?.length).toBe(2000);
  });
});

describe("shortPath", () => {
  it("writes home as a tilde, and leaves everything else alone", () => {
    expect(shortPath("/home/me/src/jterm", "/home/me")).toBe("~/src/jterm");
    expect(shortPath("/etc/hosts", "/home/me")).toBe("/etc/hosts");
    expect(shortPath("/home/me/src")).toBe("/home/me/src");
    expect(shortPath("")).toBe("");
  });
});

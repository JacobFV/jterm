import { describe, expect, it } from "vitest";

import type { TmuxSession } from "./ipc";
import {
  decodeRecentHosts,
  hostLabel,
  remoteKey,
  sortSessions,
  splitKey,
  validHost,
  validRemoteName,
  withRecentHost,
} from "./remote";
import { windowTabId } from "./tmuxControl";

function session(name: string, activity: number): TmuxSession {
  return { name, windows: 1, attached: true, activity, path: "", command: "" };
}

describe("remote keys", () => {
  it("round-trip through the last colon", () => {
    expect(splitKey(remoteKey("me@gb10", "jterm-ab12"))).toEqual({
      host: "me@gb10",
      name: "jterm-ab12",
    });
  });

  it("leave a local session's key exactly as it was", () => {
    // Every snapshot written before remote sessions existed holds these.
    expect(splitKey("work")).toEqual({ host: null, name: "work" });
  });

  it("give a remote session's tabs ids of their own", () => {
    // Derived ids are what keep a layout change from remounting a terminal, so
    // a remote window must not land on the same tab as a local one.
    expect(windowTabId(remoteKey("gb10", "work"), "@1")).not.toBe(windowTabId("work", "@1"));
  });
});

describe("validHost", () => {
  it("takes what ssh takes and refuses what it would read as an option", () => {
    expect(validHost("gb10")).toBe(true);
    expect(validHost("brandonin@10.32.127.52")).toBe(true);
    expect(validHost("-oProxyCommand=x")).toBe(false);
    expect(validHost("gb10 && rm")).toBe(false);
    expect(validHost("")).toBe(false);
  });
});

describe("validRemoteName", () => {
  it("refuses only what cannot be quoted for the far end", () => {
    expect(validRemoteName("my work")).toBe(true);
    for (const bad of ["a'b", 'a"b', "$x", "`x`", "a\\b", "a!b", "a\nb", ""]) {
      expect(validRemoteName(bad)).toBe(false);
    }
  });
});

describe("hostLabel", () => {
  it("is the machine's short name", () => {
    expect(hostLabel("me@gb10.local")).toBe("gb10");
    expect(hostLabel("gb10")).toBe("gb10");
    expect(hostLabel("me@10.32.127.52")).toBe("10.32.127.52");
  });
});

describe("sortSessions", () => {
  it("puts the most recently active first", () => {
    const sorted = sortSessions([session("a", 1), session("b", 3), session("c", 2)]);
    expect(sorted.map((entry) => entry.name)).toEqual(["b", "c", "a"]);
  });
});

describe("recent hosts", () => {
  it("drops what is not a host rather than the whole list", () => {
    expect(decodeRecentHosts(JSON.stringify(["gb10", 4, "-bad", "gb10", "pi"]))).toEqual([
      "gb10",
      "pi",
    ]);
    expect(decodeRecentHosts("not json")).toEqual([]);
    expect(decodeRecentHosts(JSON.stringify({ gb10: true }))).toEqual([]);
    expect(decodeRecentHosts(null)).toEqual([]);
  });

  it("moves a host used again to the front", () => {
    expect(withRecentHost(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });
});

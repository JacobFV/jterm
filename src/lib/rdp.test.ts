import { describe, expect, it } from "vitest";

import {
  coalesce,
  decodeRect,
  formatRdpAddress,
  isFingerprint,
  parseRdpAddress,
  type RdpInput,
} from "./rdp";

describe("parseRdpAddress", () => {
  it("defaults to 3389 and reads a port after one colon", () => {
    expect(parseRdpAddress("winbox")).toEqual({ host: "winbox", port: 3389 });
    expect(parseRdpAddress("winbox:3390")).toEqual({ host: "winbox", port: 3390 });
  });

  it("takes rdp:// links and IPv6", () => {
    expect(parseRdpAddress("rdp://me@10.0.0.9")).toEqual({ host: "10.0.0.9", port: 3389 });
    expect(parseRdpAddress("[fe80::2]:3390")).toEqual({ host: "fe80::2", port: 3390 });
    expect(parseRdpAddress("fe80::2")).toEqual({ host: "fe80::2", port: 3389 });
  });

  it("refuses what is not an address", () => {
    for (const junk of ["", "a b", "box:x", "box:0", "box:99999", "rdp://"]) {
      expect(parseRdpAddress(junk)).toBeNull();
    }
  });

  it("round-trips", () => {
    for (const address of [{ host: "w", port: 3389 }, { host: "fe80::2", port: 4000 }]) {
      expect(parseRdpAddress(formatRdpAddress(address))).toEqual(address);
    }
  });
});

describe("decodeRect", () => {
  it("reads the position, size and pixels", () => {
    const buffer = new ArrayBuffer(8 + 2 * 1 * 4);
    const view = new DataView(buffer);
    view.setUint16(0, 300, true);
    view.setUint16(2, 7, true);
    view.setUint16(4, 2, true);
    view.setUint16(6, 1, true);
    new Uint8Array(buffer, 8).set([1, 2, 3, 255, 4, 5, 6, 255]);
    const rect = decodeRect(buffer)!;
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([300, 7, 2, 1]);
    expect([...rect.pixels]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("drops a message whose length does not add up", () => {
    const buffer = new ArrayBuffer(8 + 3);
    new DataView(buffer).setUint16(4, 1, true);
    new DataView(buffer).setUint16(6, 1, true);
    expect(decodeRect(buffer)).toBeNull();
    expect(decodeRect(new ArrayBuffer(4))).toBeNull();
  });
});

describe("isFingerprint", () => {
  it("accepts exactly what rdp.rs writes", () => {
    expect(isFingerprint(Array(32).fill("AB").join(":"))).toBe(true);
    expect(isFingerprint(Array(32).fill("ab").join(":"))).toBe(false);
    expect(isFingerprint(Array(31).fill("AB").join(":"))).toBe(false);
    expect(isFingerprint(42)).toBe(false);
  });
});

describe("coalesce", () => {
  it("keeps only the last of a run of moves, and every edge", () => {
    const events: RdpInput[] = [
      { kind: "move", x: 1, y: 1 },
      { kind: "move", x: 2, y: 2 },
      { kind: "button", button: 0, down: true },
      { kind: "move", x: 3, y: 3 },
      { kind: "move", x: 4, y: 4 },
      { kind: "button", button: 0, down: false },
    ];
    expect(coalesce(events)).toEqual([
      { kind: "move", x: 2, y: 2 },
      { kind: "button", button: 0, down: true },
      { kind: "move", x: 4, y: 4 },
      { kind: "button", button: 0, down: false },
    ]);
  });
});

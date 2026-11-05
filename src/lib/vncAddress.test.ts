import { describe, expect, it } from "vitest";

import { formatVncAddress, parseVncAddress } from "./vncAddress";

describe("parseVncAddress", () => {
  it("defaults to the usual port", () => {
    expect(parseVncAddress("mac-mini.local")).toEqual({ host: "mac-mini.local", port: 5900 });
    expect(parseVncAddress("  10.0.0.7 ")).toEqual({ host: "10.0.0.7", port: 5900 });
  });

  it("reads one colon and a small number as a display", () => {
    expect(parseVncAddress("box:1")).toEqual({ host: "box", port: 5901 });
    expect(parseVncAddress("box:0")).toEqual({ host: "box", port: 5900 });
  });

  it("reads one colon and a large number as a port", () => {
    expect(parseVncAddress("box:5905")).toEqual({ host: "box", port: 5905 });
  });

  it("reads two colons as a port, whatever the number", () => {
    expect(parseVncAddress("box::5")).toEqual({ host: "box", port: 5 });
    expect(parseVncAddress("box::5901")).toEqual({ host: "box", port: 5901 });
  });

  it("takes vnc:// links, with or without a user", () => {
    expect(parseVncAddress("vnc://me@studio.local")).toEqual({ host: "studio.local", port: 5900 });
    expect(parseVncAddress("VNC://studio.local:5901/")).toEqual({ host: "studio.local", port: 5901 });
  });

  it("handles IPv6, bracketed or bare", () => {
    expect(parseVncAddress("[fe80::1]:5901")).toEqual({ host: "fe80::1", port: 5901 });
    expect(parseVncAddress("[fe80::1]:2")).toEqual({ host: "fe80::1", port: 5902 });
    expect(parseVncAddress("[fe80::1]")).toEqual({ host: "fe80::1", port: 5900 });
    expect(parseVncAddress("fe80::1")).toEqual({ host: "fe80::1", port: 5900 });
  });

  it("refuses what is not an address", () => {
    for (const junk of ["", "   ", "box:abc", "box:70000", "a b", "box;rm", "vnc://"]) {
      expect(parseVncAddress(junk)).toBeNull();
    }
  });
});

describe("formatVncAddress", () => {
  it("leaves the port off when it is the usual one", () => {
    expect(formatVncAddress({ host: "box", port: 5900 })).toBe("box");
    expect(formatVncAddress({ host: "box", port: 5901 })).toBe("box:5901");
    expect(formatVncAddress({ host: "fe80::1", port: 5901 })).toBe("[fe80::1]:5901");
  });

  it("round-trips through the parser", () => {
    for (const address of [
      { host: "box", port: 5900 },
      { host: "box", port: 6000 },
      { host: "fe80::1", port: 5901 },
    ]) {
      expect(parseVncAddress(formatVncAddress(address))).toEqual(address);
    }
  });
});

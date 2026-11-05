import { describe, expect, it } from "vitest";

import { scancodeFor } from "./scancodes";

describe("scancodeFor", () => {
  it("knows the letters by where they sit, not what they say", () => {
    expect(scancodeFor("KeyA")).toBe(0x1e);
    expect(scancodeFor("KeyQ")).toBe(0x10);
    expect(scancodeFor("KeyZ")).toBe(0x2c);
  });

  it("marks the extended keys with the E0 prefix", () => {
    expect(scancodeFor("ArrowLeft")).toBe(0xe04b);
    expect(scancodeFor("ControlRight")).toBe(0xe01d);
    expect(scancodeFor("NumpadEnter")).toBe(0xe01c);
    // …and leaves their unextended twins alone.
    expect(scancodeFor("ControlLeft")).toBe(0x1d);
    expect(scancodeFor("Enter")).toBe(0x1c);
  });

  it("sends Command as the Windows key", () => {
    expect(scancodeFor("MetaLeft")).toBe(0xe05b);
  });

  it("has nothing for keys RDP cannot name", () => {
    expect(scancodeFor("Fn")).toBeNull();
    expect(scancodeFor("")).toBeNull();
  });
});

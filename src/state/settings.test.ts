import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULTS,
  LIMITS,
  decodeSettings,
  getSettings,
  resetSettings,
  updateSettings,
  zoomText,
} from "./settings";

describe("decodeSettings", () => {
  it("treats a missing or unreadable file as no settings at all", () => {
    expect(decodeSettings(null)).toBeNull();
    expect(decodeSettings("")).toBeNull();
    expect(decodeSettings("{not json")).toBeNull();
    // A file that parses but is not an object has nothing to read fields off.
    expect(decodeSettings("[1,2,3]")).toBeNull();
    expect(decodeSettings("42")).toBeNull();
  });

  it("fills in everything an empty object leaves out", () => {
    expect(decodeSettings("{}")).toEqual(DEFAULTS);
  });

  it("clamps numbers to what the controls can express", () => {
    const huge = decodeSettings(JSON.stringify({ fontSize: 999, sidebarWidth: 99999 }))!;
    expect(huge.fontSize).toBe(LIMITS.fontSize.max);
    expect(huge.sidebarWidth).toBe(LIMITS.sidebarWidth.max);

    const tiny = decodeSettings(JSON.stringify({ fontSize: -5, uiFontSize: 0 }))!;
    expect(tiny.fontSize).toBe(LIMITS.fontSize.min);
    expect(tiny.uiFontSize).toBe(LIMITS.uiFontSize.min);
  });

  it("falls back per field rather than giving up on the file", () => {
    const mixed = decodeSettings(
      JSON.stringify({ theme: "chartreuse", cursorStyle: "block", fontSize: "big" }),
    )!;
    expect(mixed.theme).toBe(DEFAULTS.theme);
    expect(mixed.fontSize).toBe(DEFAULTS.fontSize);
    // The one good value in there still survives.
    expect(mixed.cursorStyle).toBe("block");
  });

  it("rejects numbers that are not numbers", () => {
    const broken = decodeSettings(JSON.stringify({ scrollback: NaN, lineHeight: null }))!;
    expect(broken.scrollback).toBe(DEFAULTS.scrollback);
    expect(broken.lineHeight).toBe(DEFAULTS.lineHeight);
  });

  it("takes a file-opening preference it recognises, and no other", () => {
    const chosen = decodeSettings(
      JSON.stringify({ openFilesIn: "pane", openPaneDirection: "down" }),
    )!;
    expect(chosen.openFilesIn).toBe("pane");
    expect(chosen.openPaneDirection).toBe("down");

    // "sideways" is not a split this app can make, and a hand-edited file is
    // where that would come from.
    const nonsense = decodeSettings(
      JSON.stringify({ openFilesIn: "window", openPaneDirection: "sideways" }),
    )!;
    expect(nonsense.openFilesIn).toBe(DEFAULTS.openFilesIn);
    expect(nonsense.openPaneDirection).toBe(DEFAULTS.openPaneDirection);
  });

  it("keeps only bindings for actions that exist", () => {
    const decoded = decodeSettings(
      JSON.stringify({
        keys: { "tab.new": "Mod+Shift+N", "pane.explode": "Mod+X", "pane.zoom": 7 },
      }),
    )!;
    expect(decoded.keys).toEqual({ "tab.new": "Mod+Shift+N" });
  });

  it("carries a deliberate unbinding through", () => {
    // An empty string is not junk here: it is how "this action has no shortcut"
    // is written down, and it has to survive a round trip through the file.
    const decoded = decodeSettings(JSON.stringify({ keys: { "pane.close": "" } }))!;
    expect(decoded.keys).toEqual({ "pane.close": "" });
  });
});

describe("zoomText", () => {
  // The store is module state, so a test that moves it has to put it back.
  afterEach(() => resetSettings());

  it("steps the font size the settings slider shows", () => {
    zoomText("in");
    expect(getSettings().fontSize).toBe(DEFAULTS.fontSize + LIMITS.fontSize.step);
    zoomText("out");
    zoomText("out");
    expect(getSettings().fontSize).toBe(DEFAULTS.fontSize - LIMITS.fontSize.step);
  });

  it("stops where the slider stops", () => {
    updateSettings({ fontSize: LIMITS.fontSize.max });
    zoomText("in");
    expect(getSettings().fontSize).toBe(LIMITS.fontSize.max);

    updateSettings({ fontSize: LIMITS.fontSize.min });
    zoomText("out");
    expect(getSettings().fontSize).toBe(LIMITS.fontSize.min);
  });

  it("resets to the size jterm ships with, not to wherever you were", () => {
    // The honest consequence of zoom being the setting rather than a second
    // number laid over it — there is no earlier size of yours to return to.
    updateSettings({ fontSize: DEFAULTS.fontSize + 5 });
    zoomText("in");
    zoomText("reset");
    expect(getSettings().fontSize).toBe(DEFAULTS.fontSize);
  });

  it("leaves every other setting alone", () => {
    updateSettings({ theme: "light", scrollback: 500 });
    zoomText("in");
    expect(getSettings().theme).toBe("light");
    expect(getSettings().scrollback).toBe(500);
  });
});

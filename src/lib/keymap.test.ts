import { afterEach, describe, expect, it } from "vitest";

import {
  chordFromEvent,
  conflictingAction,
  displayKeys,
  keysFor,
  resolve,
  setKeyOverrides,
} from "./keymap";

/**
 * A key press, as much of one as anything here reads.
 *
 * There is no `navigator` under the test runner, so `isMacOS()` is false and
 * these all take the Windows/Linux path — which is the one where `Mod` and
 * `Ctrl` collapse onto the same physical key and the matching is fiddliest.
 */
function press(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    code: "",
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  } as KeyboardEvent;
}

// The table is module state, so a test that changes it has to put it back.
afterEach(() => setKeyOverrides({}));

describe("resolve", () => {
  it("finds the default binding", () => {
    expect(resolve(press("t", { ctrl: true }))).toEqual({ id: "tab.new" });
    expect(resolve(press("d", { ctrl: true }))).toEqual({ id: "pane.splitRight" });
  });

  it("ignores a key with the wrong modifiers", () => {
    expect(resolve(press("t"))).toBeNull();
    expect(resolve(press("t", { ctrl: true, alt: true }))).toBeNull();
  });

  it("reads the numbered tabs as one action with an argument", () => {
    expect(resolve(press("3", { ctrl: true }))).toEqual({ id: "tab.byIndex", index: 2 });
  });

  it("takes the user's binding instead of the default", () => {
    setKeyOverrides({ "tab.new": "Mod+Shift+N" });
    expect(resolve(press("t", { ctrl: true }))).toBeNull();
    expect(resolve(press("n", { ctrl: true, shift: true }))).toEqual({ id: "tab.new" });
  });

  it("treats an empty binding as deliberately unbound", () => {
    setKeyOverrides({ "pane.splitRight": "" });
    // Which is the point of allowing it: Ctrl+D goes back to being the shell's.
    expect(resolve(press("d", { ctrl: true }))).toBeNull();
  });

  it("goes back to the default when the override is removed", () => {
    setKeyOverrides({ "tab.new": "Mod+Shift+N" });
    setKeyOverrides({});
    expect(resolve(press("t", { ctrl: true }))).toEqual({ id: "tab.new" });
  });

  it("round-trips a recorded chord, space included", () => {
    // The space bar arrives as `" "`, which is also the shape of a separator in
    // a written chord — so it is stored under a name, and both ends agree.
    const recorded = chordFromEvent(press(" ", { ctrl: true, shift: true }));
    expect(recorded).toBe("Mod+Shift+Space");
    setKeyOverrides({ "pane.zoom": recorded! });
    expect(resolve(press(" ", { ctrl: true, shift: true }))).toEqual({ id: "pane.zoom" });
  });
});

describe("chordFromEvent", () => {
  it("writes modifiers in the order the table uses", () => {
    expect(chordFromEvent(press("k", { ctrl: true, shift: true, alt: true }))).toBe(
      "Mod+Shift+Alt+K",
    );
  });

  it("keeps named keys as they are", () => {
    expect(chordFromEvent(press("ArrowLeft", { ctrl: true }))).toBe("Mod+ArrowLeft");
    expect(chordFromEvent(press("F11"))).toBe("F11");
  });

  it("waits for the rest of a chord that is still only modifiers", () => {
    expect(chordFromEvent(press("Shift", { shift: true }))).toBeNull();
    expect(chordFromEvent(press("Control", { ctrl: true }))).toBeNull();
  });

  it("declines the separator itself", () => {
    expect(chordFromEvent(press("+", { ctrl: true }))).toBeNull();
  });
});

describe("conflictingAction", () => {
  it("names the action already holding a chord", () => {
    expect(conflictingAction("Mod+T", "pane.zoom")).toBe("tab.new");
  });

  it("does not report an action conflicting with itself", () => {
    expect(conflictingAction("Mod+T", "tab.new")).toBeNull();
  });

  it("sees through a different spelling of the same press", () => {
    setKeyOverrides({ "pane.zoom": "Mod+Shift+Space" });
    expect(conflictingAction("Mod+Shift+space", "tab.new")).toBe("pane.zoom");
  });

  it("finds nothing for a chord nobody has", () => {
    expect(conflictingAction("Mod+Shift+Alt+F9", "tab.new")).toBeNull();
  });
});

describe("keysFor and displayKeys", () => {
  it("reports the binding in force", () => {
    expect(keysFor("tab.new")).toBe("Mod+T");
    setKeyOverrides({ "tab.new": "Mod+Shift+N" });
    expect(keysFor("tab.new")).toBe("Mod+Shift+N");
  });

  it("says something legible for an unbound action", () => {
    expect(displayKeys("")).toBe("—");
  });

  it("spells modifiers out off macOS", () => {
    expect(displayKeys("Mod+Shift+ArrowLeft")).toBe("Ctrl+Shift+←");
  });
});

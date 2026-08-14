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
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; code?: string } = {},
): KeyboardEvent {
  return {
    key,
    code: mods.code ?? "",
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

  it("answers every press that means zoom", () => {
    expect(resolve(press("=", { ctrl: true }))).toEqual({ id: "view.zoomIn" });
    // The same physical key with a finger on Shift — which is how anyone who
    // thinks of the shortcut as "Ctrl and plus" actually performs it.
    expect(resolve(press("+", { ctrl: true, shift: true }))).toEqual({ id: "view.zoomIn" });
    // And the keypad, which sends `+` with no Shift and a code of its own.
    expect(resolve(press("+", { ctrl: true, code: "NumpadAdd" }))).toEqual({ id: "view.zoomIn" });

    expect(resolve(press("-", { ctrl: true }))).toEqual({ id: "view.zoomOut" });
    expect(resolve(press("-", { ctrl: true, code: "NumpadSubtract" }))).toEqual({
      id: "view.zoomOut",
    });
    expect(resolve(press("0", { ctrl: true }))).toEqual({ id: "view.zoomReset" });
  });

  it("leaves Ctrl+_ to the shell", () => {
    // Readline's undo. `-` needs no Shift to type, so tolerating Shift on it
    // would buy a press nobody performs at the cost of one bash answers to.
    expect(resolve(press("_", { ctrl: true, shift: true }))).toBeNull();
  });

  it("reaches the default size on a layout where digits need Shift", () => {
    // AZERTY and QWERTZ put punctuation on the number row, so `0` arrives with
    // Shift held — the press is the same one, spelled differently by the OS.
    expect(resolve(press("0", { ctrl: true, shift: true, code: "Digit0" }))).toEqual({
      id: "view.zoomReset",
    });
  });

  it("reaches an aliased key by its physical position", () => {
    // A layout that puts something else on the key still zooms: the fallback is
    // where the key *is*, not what is printed on it.
    expect(resolve(press("Dead", { ctrl: true, code: "Minus" }))).toEqual({ id: "view.zoomOut" });
  });

  it("does not let an aliased key make Shift optional for everything", () => {
    // The relaxation is per key and only for the keys that need it. Mod+D and
    // Mod+Shift+D remain two different shortcuts.
    expect(resolve(press("d", { ctrl: true, shift: true }))).toEqual({ id: "pane.splitDown" });
    expect(resolve(press("t", { ctrl: true, shift: true }))).toBeNull();
  });

  it("keeps the numbered tabs out of zoom's way", () => {
    // Mod+0 is zoom and Mod+1…9 are tabs; there is no tab zero.
    expect(resolve(press("1", { ctrl: true }))).toEqual({ id: "tab.byIndex", index: 0 });
    expect(resolve(press("0", { ctrl: true }))).toEqual({ id: "view.zoomReset" });
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

  it("records a shifted key as the key itself", () => {
    // Both of these are the same press to `matches`, so both have to be stored
    // as the chord that answers both — and it keeps `+`, the separator, out of
    // a stored chord where it could not be told from a join.
    expect(chordFromEvent(press("+", { ctrl: true, shift: true }))).toBe("Mod+=");
    expect(chordFromEvent(press("+", { ctrl: true }))).toBe("Mod+=");
    expect(chordFromEvent(press(")", { ctrl: true, shift: true }))).toBe("Mod+0");
  });

  it("still records Shift where Shift is part of the chord", () => {
    expect(chordFromEvent(press("d", { ctrl: true, shift: true }))).toBe("Mod+Shift+D");
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

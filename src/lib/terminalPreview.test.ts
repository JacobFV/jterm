import { describe, expect, it } from "vitest";

import { LOOP, PROMPT, finalFrame, frameAt, offsetFor, type Frame } from "./terminalPreview";

const text = (frame: Frame) => frame.lines.map((line) => line.map((span) => span.text).join(""));
const prompt = PROMPT.map((span) => span.text).join("");

describe("frameAt", () => {
  it("starts on an empty prompt with the cursor on it", () => {
    expect(text(frameAt(0))).toEqual([prompt]);
    expect(frameAt(0).cursor).toBe(true);
  });

  it("types a command one character at a time", () => {
    const lengths = [5, 6, 7].map((tick) => text(frameAt(tick))[0].length);
    expect(lengths[1] - lengths[0]).toBe(1);
    expect(lengths[2] - lengths[1]).toBe(1);
  });

  it("only ever grows within a loop", () => {
    for (let tick = 1; tick < LOOP; tick++) {
      expect(frameAt(tick).lines.length).toBeGreaterThanOrEqual(frameAt(tick - 1).lines.length);
    }
  });

  it("ends on a fresh prompt, and starts over after the loop", () => {
    const last = text(finalFrame());
    expect(last[last.length - 1]).toBe(prompt);
    expect(last.length).toBeGreaterThan(5);
    expect(frameAt(LOOP)).toEqual(frameAt(0));
    expect(frameAt(-1)).toEqual(finalFrame());
  });

  it("keeps every line narrow enough for a preview", () => {
    for (const line of text(finalFrame())) expect(line.length).toBeLessThanOrEqual(28);
  });
});

describe("offsetFor", () => {
  it("is stable, inside the loop, and not the same for every theme", () => {
    expect(offsetFor("dark")).toBe(offsetFor("dark"));
    const offsets = ["dark", "light", "nord", "dracula", "gruvbox"].map(offsetFor);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(LOOP);
    }
    expect(new Set(offsets).size).toBeGreaterThan(1);
  });
});

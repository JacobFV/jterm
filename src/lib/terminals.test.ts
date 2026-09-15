import { describe, expect, it } from "vitest";

import { tailText, type BufferLike } from "./terminals";

function buffer(rows: [string, boolean?][]): BufferLike {
  return {
    length: rows.length,
    getLine: (index) => {
      const row = rows[index];
      if (row === undefined) return undefined;
      return { isWrapped: row[1] === true, translateToString: () => row[0] };
    },
  };
}

describe("tailText", () => {
  it("joins rows the terminal wrapped back into one line", () => {
    const text = tailText(buffer([["$ cargo build"], ["error: a very long mess"], ["age here", true]]), 10);
    expect(text).toBe("$ cargo build\nerror: a very long message here");
  });

  it("keeps only the last lines and drops the empty screen below the prompt", () => {
    const text = tailText(buffer([["one"], ["two"], ["three"], [""], ["   "]]), 2);
    expect(text).toBe("two\nthree");
  });

  it("returns nothing for an empty buffer", () => {
    expect(tailText(buffer([]), 5)).toBe("");
  });
});

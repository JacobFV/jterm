import { describe, expect, it } from "vitest";

import { splitArgs } from "./argv";

describe("splitArgs", () => {
  it("splits on runs of whitespace", () => {
    expect(splitArgs("  npx   @google/gemini-cli\t--yolo ")).toEqual([
      "npx",
      "@google/gemini-cli",
      "--yolo",
    ]);
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("   ")).toEqual([]);
  });

  it("keeps quoted spaces and joins quoted parts of one word", () => {
    expect(splitArgs(`--model "claude opus" --name='a b'`)).toEqual([
      "--model",
      "claude opus",
      "--name=a b",
    ]);
  });

  it("treats single quotes literally and double quotes as a shell does", () => {
    expect(splitArgs(`'a\\b "c"'`)).toEqual([`a\\b "c"`]);
    expect(splitArgs(`"say \\"hi\\" \\n"`)).toEqual([`say "hi" \\n`]);
  });

  it("escapes the next character outside quotes", () => {
    expect(splitArgs("a\\ b c")).toEqual(["a b", "c"]);
  });

  it("keeps an explicitly empty argument", () => {
    expect(splitArgs(`--prompt "" x`)).toEqual(["--prompt", "", "x"]);
  });

  it("expands nothing", () => {
    expect(splitArgs("$HOME/bin/claude ~/x")).toEqual(["$HOME/bin/claude", "~/x"]);
  });

  it("lets an unclosed quote run to the end", () => {
    expect(splitArgs(`a "b c`)).toEqual(["a", "b c"]);
  });
});

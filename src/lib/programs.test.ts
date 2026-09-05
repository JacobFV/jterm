import { describe, expect, it } from "vitest";

import { PROGRAMS, programById, programForCommand, resumeLine } from "./programs";

describe("programForCommand", () => {
  it("recognises the program from the first real word", () => {
    expect(programForCommand("claude")?.id).toBe("claude");
    expect(programForCommand("kubectl get pods")?.id).toBe("k8s");
    expect(programForCommand("psql -h db")?.id).toBe("sql");
  });

  it("steps over the things people put in front of a command", () => {
    expect(programForCommand("sudo docker ps")?.id).toBe("docker");
    expect(programForCommand("ANTHROPIC_LOG=1 claude")?.id).toBe("claude");
    expect(programForCommand("env FOO=1 npx claude --continue")?.id).toBe("claude");
    expect(programForCommand("/usr/local/bin/nvim src/a.ts")?.id).toBe("editor");
  });

  it("does not guess at something that merely starts the same way", () => {
    expect(programForCommand("claude-helper.sh")).toBeNull();
    expect(programForCommand("./deploy")).toBeNull();
    expect(programForCommand("")).toBeNull();
    expect(programForCommand(undefined)).toBeNull();
  });
});

describe("resumeLine", () => {
  it("uses a tool's own resume where it has one", () => {
    expect(resumeLine("claude")).toBe("claude --continue");
    expect(resumeLine("claude -p 'do the thing'")).toBe("claude --continue");
  });

  it("hands back the command itself where that is the resume", () => {
    expect(resumeLine("ssh prod-1")).toBe("ssh prod-1");
  });

  it("offers nothing for a command that was not a session", () => {
    // A finished `ls` is not something anybody wants typed back at them, and a
    // pane that came back with a surprise pre-typed would be worse than one
    // that came back empty.
    expect(resumeLine("ls -la")).toBeNull();
    expect(resumeLine("kubectl get pods")).toBeNull();
    expect(resumeLine(undefined)).toBeNull();
  });
});

describe("the catalogue", () => {
  it("has no two entries sharing an id", () => {
    const ids = PROGRAMS.map((program) => program.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds every entry by its id, and nothing by a stale one", () => {
    for (const program of PROGRAMS) expect(programById(program.id)?.label).toBe(program.label);
    expect(programById("a-profile-that-was-removed")).toBeNull();
    expect(programById(undefined)).toBeNull();
  });
});

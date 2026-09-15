import { describe, expect, it } from "vitest";

import {
  agentFromForeground,
  decodeAgent,
  resumeCommand,
  resumeFlags,
  sameAgent,
  shellQuote,
} from "./agents";

const SESSION = "8155b3bc-1a64-47e9-8c56-db7c2664a5e6";

describe("resumeFlags", () => {
  it("keeps the flags that change how a session behaves, and drops the prompt", () => {
    expect(
      resumeFlags("claude", ["--dangerously-skip-permissions", "--model", "opus", "fix the bug"]),
    ).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
  });

  it("keeps a valued flag written with an equals sign", () => {
    expect(resumeFlags("claude", ["--permission-mode=plan"])).toEqual(["--permission-mode=plan"]);
  });

  it("drops a flag whose value would need quoting", () => {
    expect(resumeFlags("claude", ["--model", "opus; rm -rf ~"])).toEqual([]);
    expect(resumeFlags("claude", ["--add-dir=/tmp/a b"])).toEqual([]);
    // Not on the list at all: its value is a prompt of its own.
    expect(resumeFlags("claude", ["--append-system-prompt", "be terse"])).toEqual([]);
  });

  it("reads each tool's letters as that tool means them", () => {
    expect(resumeFlags("codex", ["-s", "workspace-write"])).toEqual(["-s", "workspace-write"]);
    expect(resumeFlags("gemini", ["-s", "--yolo"])).toEqual(["-s", "--yolo"]);
    // `-p` is a profile to Codex and print mode to Claude, which a resume must
    // not inherit.
    expect(resumeFlags("claude", ["-p", "hello"])).toEqual([]);
  });

  it("does not take the next flag as a value", () => {
    expect(resumeFlags("codex", ["-m", "--search"])).toEqual(["--search"]);
  });
});

describe("resumeCommand", () => {
  it("resumes the conversation itself when its id is known", () => {
    expect(resumeCommand({ tool: "claude", session: SESSION })).toBe(`claude --resume ${SESSION}`);
    expect(resumeCommand({ tool: "codex", session: SESSION })).toBe(`codex resume ${SESSION}`);
    expect(resumeCommand({ tool: "gemini", session: SESSION })).toBe(`gemini --resume ${SESSION}`);
  });

  it("falls back to each tool's most recent conversation without one", () => {
    expect(resumeCommand({ tool: "claude" })).toBe("claude --continue");
    expect(resumeCommand({ tool: "codex" })).toBe("codex resume --last");
    expect(resumeCommand({ tool: "gemini" })).toBe("gemini --resume latest");
  });

  it("carries the flags it was started with", () => {
    expect(
      resumeCommand({ tool: "claude", session: SESSION, flags: ["--dangerously-skip-permissions"] }),
    ).toBe(`claude --resume ${SESSION} --dangerously-skip-permissions`);
  });

  it("goes where the agent was, and only when that is somewhere else", () => {
    const agent = { tool: "claude" as const, cwd: "/home/u/it's here" };
    expect(resumeCommand(agent, "/home/u")).toBe(`cd '/home/u/it'\\''s here' && claude --continue`);
    expect(resumeCommand(agent, "/home/u/it's here")).toBe("claude --continue");
  });
});

describe("decodeAgent", () => {
  it("keeps a record that is sound", () => {
    const record = { tool: "claude", session: SESSION, cwd: "/w", flags: ["--verbose"] };
    expect(decodeAgent(record)).toEqual(record);
  });

  it("costs the record only when the tool is unknown", () => {
    expect(decodeAgent({ tool: "bash", session: SESSION })).toBeUndefined();
    expect(decodeAgent("claude")).toBeUndefined();
    expect(decodeAgent(null)).toBeUndefined();
  });

  it("costs a field, not the record, when the field is junk", () => {
    const decoded = decodeAgent({
      tool: "codex",
      session: "$(reboot)",
      cwd: "/w\nrm -rf ~",
      flags: ["--search", 7, "; reboot"],
    });
    expect(decoded).toEqual({ tool: "codex", flags: ["--search"] });
  });
});

describe("agentFromForeground", () => {
  it("is nothing for a shell at its prompt or a program that is no agent", () => {
    expect(agentFromForeground(null)).toBeUndefined();
    expect(
      agentFromForeground({ tool: null, name: "cargo", session: null, cwd: "/w", args: [] }),
    ).toBeUndefined();
  });

  it("keeps what a resume needs from a running agent", () => {
    const agent = agentFromForeground({
      tool: "claude",
      name: "claude",
      session: SESSION,
      cwd: "/w",
      args: ["--dangerously-skip-permissions", "summarise the logs"],
    });
    expect(agent).toEqual({
      tool: "claude",
      session: SESSION,
      cwd: "/w",
      flags: ["--dangerously-skip-permissions"],
    });
    expect(sameAgent(agent, decodeAgent(JSON.parse(JSON.stringify(agent))))).toBe(true);
  });
});

describe("shellQuote", () => {
  it("makes one word of anything", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

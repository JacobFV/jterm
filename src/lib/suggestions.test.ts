import { describe, expect, it } from "vitest";

import { type PaneFacts, suggestionsFor } from "./suggestions";

const SESSION = "8155b3bc-1a64-47e9-8c56-db7c2664a5e6";

/** A pane that came back after a crash, sitting at a prompt, on a plain shell. */
function restored(overrides: Partial<PaneFacts> = {}): PaneFacts {
  return {
    restored: true,
    idle: true,
    cwd: "/home/u/work",
    onTmux: false,
    tmuxAvailable: true,
    newTerminalsOnTmux: true,
    quiet: [],
    ...overrides,
  };
}

const ids = (facts: PaneFacts) => suggestionsFor(facts).map((suggestion) => suggestion.id);

describe("suggestionsFor", () => {
  it("offers nothing to a pane that did not lose anything", () => {
    const agent = { tool: "claude" as const, session: SESSION };
    expect(suggestionsFor(restored({ restored: false, agent }))).toEqual([]);
  });

  it("resumes the agent's own conversation, with the flags it had", () => {
    const [resume] = suggestionsFor(
      restored({
        agent: {
          tool: "claude",
          session: SESSION,
          cwd: "/home/u/work",
          flags: ["--dangerously-skip-permissions"],
        },
      }),
    );
    expect(resume.title).toBe("Resume Claude Code");
    const run = resume.actions.find((action) => action.kind === "run");
    expect(run?.command).toBe(`claude --resume ${SESSION} --dangerously-skip-permissions`);
    expect(resume.actions.some((action) => action.kind === "type")).toBe(true);
  });

  it("says when resuming will put the agent in tmux", () => {
    const agent = { tool: "codex" as const };
    expect(suggestionsFor(restored({ agent }))[0].detail).toContain("tmux");
    expect(suggestionsFor(restored({ agent, onTmux: true }))[0].detail).not.toContain("tmux");
  });

  it("falls back to the last command for a pane with no agent on record", () => {
    const claude = suggestionsFor(restored({ command: "claude" }));
    expect(claude[0].id).toBe("resume-command");
    expect(claude[0].actions[0].command).toBe("claude --continue");

    const ssh = suggestionsFor(restored({ command: "ssh prod-1" }));
    expect(ssh[0].actions[0].command).toBe("ssh prod-1");

    // A finished `ls` is not a session anybody wants back.
    expect(ids(restored({ command: "ls -la" }))).toEqual([]);
  });

  it("stays out of the way of a pane that has something running", () => {
    const agent = { tool: "claude" as const, session: SESSION };
    expect(ids(restored({ agent, idle: false, newTerminalsOnTmux: false }))).toEqual([]);
  });

  it("offers tmux to a plain shell that was just lost, while the setting says otherwise", () => {
    expect(ids(restored({ newTerminalsOnTmux: false }))).toEqual(["use-tmux"]);
    // The setting already says tmux: resuming moves the pane, so there is
    // nothing to ask.
    expect(ids(restored({ newTerminalsOnTmux: true }))).toEqual([]);
    expect(ids(restored({ newTerminalsOnTmux: false, onTmux: true }))).toEqual([]);
    expect(ids(restored({ newTerminalsOnTmux: false, tmuxAvailable: false }))).toEqual([]);
  });

  it("never offers what the user asked never to see", () => {
    expect(ids(restored({ newTerminalsOnTmux: false, quiet: ["use-tmux"] }))).toEqual([]);
  });

  it("puts what was lost before how not to lose it again", () => {
    const agent = { tool: "claude" as const, session: SESSION };
    expect(ids(restored({ agent, newTerminalsOnTmux: false }))).toEqual([
      "resume-agent",
      "use-tmux",
    ]);
  });
});

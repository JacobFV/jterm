/**
 * The agent a pane was running, kept so the pane can offer to resume it.
 *
 * The backend reads what is in a pane's foreground — see
 * `src-tauri/src/agents.rs` — and this is the part of that answer worth keeping
 * in the snapshot: which agent, its own id for the conversation, where it ran,
 * and the flags it was started with. Everything else about the process is gone
 * the moment it is, and none of it is needed to start it again.
 *
 * Both ends of one string live here. The record is decoded from a file that
 * survived a crash, and it is turned into a command line typed into a shell —
 * so every field is validated on the way in, and nothing reaches the command
 * line that did not pass on the way.
 */

import type { Foreground } from "./ipc";

export type AgentTool = "claude" | "codex" | "gemini";
const TOOLS: readonly AgentTool[] = ["claude", "codex", "gemini"];

export interface AgentRecord {
  tool: AgentTool;
  /** The agent's own id for the conversation, where the process gave it away. */
  session?: string;
  /** Where the agent ran. Every one of them files conversations by directory,
   *  so a resume has to run there too. */
  cwd?: string;
  /** The flags it was started with, and only the ones `resumeFlags` keeps. */
  flags?: string[];
}

/** A conversation id: UUID-shaped, and safe to type unquoted. */
const SESSION = /^[A-Za-z0-9-]{8,64}$/;
/** A flag's value, typed unquoted — so nothing a shell would read as syntax. */
const VALUE = /^[A-Za-z0-9_./:@+,=~-]{1,200}$/;
const MAX_CWD = 4096;
/** Words, not flags: a valued flag is two. */
const MAX_FLAG_WORDS = 24;

/**
 * The flags worth carrying into a resume, per agent — and only these.
 *
 * An allowlist, because the alternative is deciding which of a command line's
 * words are flags and which are a prompt, and getting that wrong re-sends a
 * prompt the agent already acted on. What is listed changes *how* a session
 * behaves — permissions, model, sandbox, extra directories — which is what
 * someone resuming would be surprised to have lost. Taken from each tool's own
 * `--help`; the same letter means different things to different tools (`-s` is
 * a sandbox mode for Codex and a switch for Gemini), hence one table each.
 */
const FLAGS: Record<AgentTool, { switches: string[]; values: string[] }> = {
  claude: {
    switches: [
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--verbose",
      "--ide",
      "--chrome",
      "--no-chrome",
      "--strict-mcp-config",
      "--safe-mode",
      "--brief",
    ],
    values: [
      "--model",
      "--permission-mode",
      "--add-dir",
      "--settings",
      "--mcp-config",
      "--effort",
      "--fallback-model",
      "--agent",
      "--plugin-dir",
      "--setting-sources",
    ],
  },
  codex: {
    switches: [
      "--dangerously-bypass-approvals-and-sandbox",
      "--search",
      "--oss",
      "--no-alt-screen",
      "--approve-for-me",
    ],
    values: [
      "-m",
      "--model",
      "-p",
      "--profile",
      "-s",
      "--sandbox",
      "-a",
      "--ask-for-approval",
      "-c",
      "--config",
      "--enable",
      "--disable",
      "--add-dir",
      "--local-provider",
    ],
  },
  gemini: {
    switches: ["--yolo", "-y", "--sandbox", "-s", "--screen-reader"],
    values: ["-m", "--model", "--approval-mode", "--include-directories", "-e", "--extensions"],
  },
};

/**
 * The flags out of an agent's arguments that a resume should start with.
 *
 * A valued flag keeps its value only when the value is plain enough to type
 * unquoted; one that is not is dropped along with its flag, rather than typed
 * in a way that might mean something else to the shell.
 */
export function resumeFlags(tool: AgentTool, args: readonly unknown[]): string[] {
  const { switches, values } = FLAGS[tool];
  const kept: string[] = [];
  for (let index = 0; index < args.length && kept.length < MAX_FLAG_WORDS; index++) {
    const arg = args[index];
    if (typeof arg !== "string") continue;

    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals > 0) {
      if (values.includes(arg.slice(0, equals)) && VALUE.test(arg.slice(equals + 1))) {
        kept.push(arg);
      }
      continue;
    }
    if (switches.includes(arg)) {
      kept.push(arg);
      continue;
    }
    if (values.includes(arg)) {
      const value = args[index + 1];
      if (typeof value === "string" && !value.startsWith("-") && VALUE.test(value)) {
        kept.push(arg, value);
        index++;
      }
    }
  }
  return kept;
}

/**
 * An agent record, validated field by field — for the snapshot, and for the
 * backend's answer, which get the same suspicion.
 *
 * An unknown tool costs the record; anything else that fails costs that field.
 * The fields are written in a fixed order so two equal records serialise alike,
 * which is what lets a pane tell whether its agent actually changed.
 */
export function decodeAgent(raw: unknown): AgentRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const tool = TOOLS.find((known) => known === value.tool);
  if (tool === undefined) return undefined;

  const record: AgentRecord = { tool };
  if (typeof value.session === "string" && SESSION.test(value.session)) {
    record.session = value.session;
  }
  if (
    typeof value.cwd === "string" &&
    value.cwd.length > 0 &&
    value.cwd.length <= MAX_CWD &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(value.cwd)
  ) {
    record.cwd = value.cwd;
  }
  const flags = Array.isArray(value.flags) ? resumeFlags(tool, value.flags) : [];
  if (flags.length > 0) record.flags = flags;
  return record;
}

/** The record for whatever the backend found running, or `undefined` if it is no agent. */
export function agentFromForeground(foreground: Foreground | null): AgentRecord | undefined {
  if (foreground === null || foreground.tool === null) return undefined;
  const tool = TOOLS.find((known) => known === foreground.tool);
  if (tool === undefined) return undefined;
  return decodeAgent({
    tool,
    session: foreground.session,
    cwd: foreground.cwd,
    flags: resumeFlags(tool, foreground.args),
  });
}

export function sameAgent(a: AgentRecord | undefined, b: AgentRecord | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One word to a POSIX shell, whatever is in it. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line that picks this agent's conversation back up.
 *
 * With the conversation's id where there is one, which is the whole point of
 * having kept it: four Claude panes in one repository are four conversations,
 * and "the most recent one here" is right for at most one of them. Without it,
 * each tool's own "latest in this directory" is the best there is.
 *
 * `cwd` is where the shell the command will be typed into is. When the agent
 * ran somewhere else, the command goes there first.
 */
export function resumeCommand(agent: AgentRecord, cwd?: string): string {
  const flags = agent.flags?.length ? ` ${agent.flags.join(" ")}` : "";
  const line =
    agent.tool === "claude"
      ? agent.session
        ? `claude --resume ${agent.session}${flags}`
        : `claude --continue${flags}`
      : agent.tool === "codex"
        ? `codex resume ${agent.session ?? "--last"}${flags}`
        : `gemini --resume ${agent.session ?? "latest"}${flags}`;
  return agent.cwd && agent.cwd !== cwd ? `cd ${shellQuote(agent.cwd)} && ${line}` : line;
}

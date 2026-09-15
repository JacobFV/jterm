/**
 * Things jterm can offer to do for a pane, and when each is worth offering.
 *
 * jterm notices things about a pane that the person using it may not: that its
 * shell did not survive and the agent it was running left a conversation id
 * behind, or that it was a plain shell on a machine where tmux would have kept
 * it alive. Each has an obvious next step, and the honest way to offer one is a
 * button — not text typed at the prompt for the next Enter to send, and never
 * something run on the user's behalf.
 *
 * Built as a list of rules, each a pure function from what is known about a
 * pane to at most one suggestion. Adding one is adding a function to `RULES`;
 * `TerminalPane` draws whatever comes back and carries out whichever button is
 * pressed, since it is the only thing that can act on a shell. Pure on purpose:
 * every condition here is a decision about when to interrupt somebody, and
 * those are the decisions worth having tests for.
 */

import { type AgentRecord, resumeCommand } from "./agents";
import { programById, programForCommand, resumeLine } from "./programs";

/** What a button does. `TerminalPane` is what knows how. */
export type SuggestionActionKind =
  /** Type `command` at the prompt and press Enter. */
  | "run"
  /** Type `command` at the prompt and leave it there. */
  | "type"
  /** Restart this pane's shell inside a tmux session of its own. */
  | "tmux-pane"
  /** Make tmux what new terminals run on, and move this pane onto it too. */
  | "tmux-default"
  /** Never offer this suggestion again, anywhere. */
  | "quiet";

export interface SuggestionAction {
  kind: SuggestionActionKind;
  label: string;
  /** Where a glance should land. At most one per suggestion. */
  primary?: boolean;
  /** The command line for `run` and `type`. */
  command?: string;
}

export interface Suggestion {
  /** Stable, because it is what a dismissal and `quietSuggestions` refer to. */
  id: string;
  title: string;
  detail: string;
  actions: SuggestionAction[];
}

/** Everything the rules get to look at. Gathered by `TerminalPane`. */
export interface PaneFacts {
  /** The pane came back from a snapshot and its shell did not come back with it. */
  restored: boolean;
  /** Nothing is in the foreground: the shell is sitting at its prompt. */
  idle: boolean;
  /** The agent the pane was running when it was last seen. */
  agent?: AgentRecord;
  /** The last command line started in the pane. */
  command?: string;
  /** Where the pane's shell is now. */
  cwd?: string;
  /** The pane's shell is in a tmux session jterm made for it. */
  onTmux: boolean;
  tmuxAvailable: boolean;
  /** The setting: new terminals start on tmux. */
  newTerminalsOnTmux: boolean;
  /** Suggestions the user has asked never to see again. */
  quiet: readonly string[];
}

type Rule = (facts: PaneFacts) => Suggestion | null;

/**
 * Whether a resume run now would land in tmux — which is what the pane's
 * controller does when the setting asks for it, so a pane resumed after a crash
 * does not stay exposed to the next one.
 */
function resumesIntoTmux(facts: PaneFacts): boolean {
  return !facts.onTmux && facts.newTerminalsOnTmux && facts.tmuxAvailable;
}

/**
 * The agent that was running when the shell died, back in its own conversation.
 *
 * Only while the shell is idle: once something else is running, the offer is
 * about a pane that has moved on.
 */
const resumeAgent: Rule = (facts) => {
  if (!facts.restored || !facts.idle || facts.agent === undefined) return null;
  const { agent } = facts;
  const command = resumeCommand(agent, facts.cwd);
  const label = programById(agent.tool)?.label ?? agent.tool;
  const which = agent.session
    ? `its conversation (${agent.session.slice(0, 8)})`
    : "the most recent conversation in its folder";
  const tmux = resumesIntoTmux(facts) ? ", in tmux so it survives next time" : "";
  return {
    id: "resume-agent",
    title: `Resume ${label}`,
    detail: `${label} was running here when the shell went down. Picks up ${which}${tmux}.`,
    actions: [
      { kind: "run", label: "Resume", primary: true, command },
      { kind: "type", label: "Type it", command },
    ],
  };
};

/**
 * The last thing started here, for a pane with no agent on record.
 *
 * That is every pane restored from a snapshot written before agents were
 * recorded, every platform where the process cannot be read, and the tools
 * that resume by simply being run again (`ssh prod`). `resumeLine` decides
 * which commands are worth offering at all.
 */
const resumeCommandLine: Rule = (facts) => {
  if (!facts.restored || !facts.idle || facts.agent !== undefined) return null;
  const command = resumeLine(facts.command);
  if (command === null) return null;
  const label = programForCommand(facts.command)?.label ?? "the last command";
  const tmux = resumesIntoTmux(facts) ? ", in tmux so it survives next time" : "";
  return {
    id: "resume-command",
    title: `Resume ${label}`,
    detail: `It was the last thing started here before the shell went down. Runs ${command}${tmux}.`,
    actions: [
      { kind: "run", label: "Run it", primary: true, command },
      { kind: "type", label: "Type it", command },
    ],
  };
};

/**
 * Tmux, offered at the one moment its value is obvious: just after a plain
 * shell was lost.
 *
 * Not offered to a pane that is busy — moving it restarts the shell — nor once
 * the setting already says tmux, where resuming moves the pane anyway.
 */
const useTmux: Rule = (facts) => {
  if (!facts.restored || !facts.idle || facts.onTmux || !facts.tmuxAvailable) return null;
  if (facts.newTerminalsOnTmux) return null;
  return {
    id: "use-tmux",
    title: "Keep shells alive next time",
    detail:
      "This pane was a plain shell, so it died with the app. On tmux, a shell and whatever it is running outlive jterm and are still there when it comes back.",
    actions: [
      { kind: "tmux-default", label: "Use tmux for terminals", primary: true },
      { kind: "tmux-pane", label: "Just this pane" },
      { kind: "quiet", label: "Don't ask again" },
    ],
  };
};

/** In the order they are shown: what was lost first, how to not lose it second. */
const RULES: Rule[] = [resumeAgent, resumeCommandLine, useTmux];

export function suggestionsFor(facts: PaneFacts): Suggestion[] {
  return RULES.map((rule) => rule(facts)).filter(
    (suggestion): suggestion is Suggestion =>
      suggestion !== null && !facts.quiet.includes(suggestion.id),
  );
}

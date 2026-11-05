/**
 * The welcome dialog's decisions: which steps there are, and what each offers.
 *
 * The dialog exists because the most valuable thing jterm does — shells that
 * outlive the app, by way of tmux — is also the one most likely to be quietly
 * off. tmux is the default backend, but a machine without tmux gets plain
 * shells without a word, and until `programs.rs` existed so did every Mac that
 * launched jterm from the Dock. Nobody finds that out until the first crash,
 * which is the worst possible moment. So the first launch says what the state
 * of things is and offers to fix it, and everything else it shows is there
 * because it is the second-most-likely thing a new user would go looking for.
 *
 * Every step is optional and every one can be skipped, all at once or one at a
 * time. Nothing is installed or run on the user's behalf: installing tmux opens
 * a tab with the command typed at the prompt, and pressing Enter is theirs —
 * the same promise the restored draft line and the suggestion cards make.
 *
 * Kept apart from the component so the decisions can be tested in node.
 */

import type { SetupProbe } from "./ipc";

/**
 * Raise this when a step is added that people who have already been through
 * the dialog ought to see. They will be shown the whole dialog again, which is
 * the price of keeping this a single number; it is a price worth paying rarely.
 */
export const SETUP_VERSION = 1;

export type Platform = "macos" | "linux" | "windows";

export type StepId = "welcome" | "tmux" | "look" | "agent" | "updates";

export interface Step {
  id: StepId;
  /** The short name in the step list. */
  title: string;
}

const ALL_STEPS: Step[] = [
  { id: "welcome", title: "Welcome" },
  { id: "tmux", title: "Shells that survive" },
  { id: "look", title: "Look" },
  { id: "agent", title: "Agent" },
  { id: "updates", title: "Updates" },
];

/** Whether the dialog should open by itself on this launch. */
export function shouldOfferSetup(seen: number): boolean {
  return seen < SETUP_VERSION;
}

/**
 * The steps this machine gets.
 *
 * Windows has no tmux step at all rather than one that says "not here": a
 * step whose only content is an apology for a feature is a step that wastes a
 * click on the first thing anybody sees.
 */
export function stepsFor(platform: Platform): Step[] {
  return ALL_STEPS.filter((step) => step.id !== "tmux" || platform !== "windows");
}

/**
 * What the tmux step can honestly offer.
 *
 * - `ready`: it is there. Shown with the path, so someone with two tmuxes can
 *   see which one jterm found.
 * - `install`: macOS with Homebrew. A button opens a tab with `command` typed.
 * - `homebrew`: macOS without Homebrew. There is no command worth typing — the
 *   Homebrew installer is a `curl | bash` that belongs to its own site, where
 *   it can be read first — so this links there.
 * - `manual`: Linux. Which package manager is a question jterm cannot answer
 *   reliably, and a wrong guess typed at a prompt with `sudo` in front of it is
 *   worse than a sentence listing the usual ones.
 * - `unsupported`: Windows, for completeness; `stepsFor` keeps the step away.
 */
export type TmuxOffer =
  | { kind: "ready"; path: string }
  | { kind: "install"; command: string }
  | { kind: "homebrew"; url: string }
  | { kind: "manual"; commands: string[] }
  | { kind: "unsupported" };

export const HOMEBREW_URL = "https://brew.sh";

export function tmuxOffer(probe: SetupProbe, platform: Platform): TmuxOffer {
  if (platform === "windows") return { kind: "unsupported" };
  if (probe.tmux !== null) return { kind: "ready", path: probe.tmux };
  if (platform === "macos") {
    return probe.brew !== null
      ? { kind: "install", command: "brew install tmux" }
      : { kind: "homebrew", url: HOMEBREW_URL };
  }
  return {
    kind: "manual",
    commands: ["sudo apt install tmux", "sudo dnf install tmux", "sudo pacman -S tmux"],
  };
}

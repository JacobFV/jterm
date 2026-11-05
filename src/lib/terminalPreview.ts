/**
 * The little terminal a theme's preview shows, typing.
 *
 * A palette's colours in a row say what the colours are, which is not what
 * anyone choosing a theme wants to know. They want to know what their terminal
 * will look like: whether a red `M` in `git status` is legible on that
 * background, whether a directory listing's blue disappears, whether the
 * comment grey is too faint to read. So the preview is a terminal — a prompt,
 * commands typed a character at a time, the output those commands really
 * produce, coloured the way the tools really colour it.
 *
 * Time is counted in ticks so that what is on screen at any moment is a pure
 * function of one number. That is what makes this testable, and what lets
 * thirty previews share one clock: each just starts somewhere else along it.
 */

import type { Palette } from "./themes";

/** The palette entries the script draws with. */
export type Ink = keyof Pick<
  Palette,
  "fg" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "brightBlack"
>;

export interface Span {
  text: string;
  ink: Ink;
}

type Entry = { command: string } | { output: Span[] };

export const PROMPT: Span[] = [
  { text: "~/src ", ink: "blue" },
  { text: "❯ ", ink: "magenta" },
];

/**
 * Short lines, because a preview is about 170px across: nothing here is wider
 * than about 26 characters. Between them the commands use six of the eight
 * hues plus the dim grey, which is most of what a palette gets judged on.
 */
const SCRIPT: Entry[] = [
  { command: "git status -s" },
  { output: [{ text: " M ", ink: "red" }, { text: "src/App.tsx", ink: "fg" }] },
  { output: [{ text: "?? ", ink: "green" }, { text: "notes.md", ink: "fg" }] },
  { command: "npm test" },
  { output: [{ text: "✓ ", ink: "green" }, { text: "404 passed", ink: "fg" }] },
  { output: [{ text: "↓ ", ink: "yellow" }, { text: "1 skipped", ink: "brightBlack" }] },
  { command: "ls" },
  {
    output: [
      { text: "docs/  ", ink: "blue" },
      { text: "src/  ", ink: "blue" },
      { text: "run.sh  ", ink: "green" },
      { text: "README", ink: "fg" },
    ],
  },
  { command: "echo $SHELL" },
  { output: [{ text: "/bin/zsh", ink: "cyan" }] },
];

/** Ticks of a prompt sitting there before typing starts, as a person would. */
const THINK = 4;
/** Ticks between the last character and the output, the command "running". */
const ENTER = 3;
/** Ticks the finished screen is held before it starts again. */
const HOLD = 24;

function cost(entry: Entry): number {
  return "command" in entry ? THINK + entry.command.length + ENTER : 1;
}

/** One pass of the script, in ticks. */
export const LOOP = SCRIPT.reduce((total, entry) => total + cost(entry), 0) + HOLD;

export interface Frame {
  lines: Span[][];
  /** Whether the last line is a prompt, and so where the cursor sits. */
  cursor: boolean;
}

/** What is on screen `tick` ticks into the loop. Any integer works. */
export function frameAt(tick: number): Frame {
  let t = ((tick % LOOP) + LOOP) % LOOP;
  const lines: Span[][] = [];
  for (const entry of SCRIPT) {
    const spent = cost(entry);
    if ("command" in entry) {
      if (t < spent) {
        const typed = Math.min(entry.command.length, Math.max(0, t - THINK));
        lines.push([...PROMPT, { text: entry.command.slice(0, typed), ink: "fg" }]);
        return { lines, cursor: true };
      }
      lines.push([...PROMPT, { text: entry.command, ink: "fg" }]);
    } else {
      lines.push(entry.output);
      // Mid-output, nothing is waiting for input, so there is no cursor.
      if (t < spent) return { lines, cursor: false };
    }
    t -= spent;
  }
  lines.push([...PROMPT]);
  return { lines, cursor: true };
}

/** The whole script, finished — what a preview shows when nothing may move. */
export function finalFrame(): Frame {
  return frameAt(LOOP - 1);
}

/**
 * Where along the loop a given theme starts, so a grid of previews is not
 * thirty terminals typing the same letter at the same moment.
 */
export function offsetFor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % LOOP;
}

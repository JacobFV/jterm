/**
 * Every keyboard shortcut, in one table.
 *
 * `Mod` is Command on macOS and Control everywhere else.
 *
 * ── A note on Mod+D ──────────────────────────────────────────────────────
 * Splitting on `Mod+D` is borrowed from iTerm2, where it is `Cmd+D` and costs
 * nothing. On Windows and Linux the same shortcut is `Ctrl+D`, which is the
 * shell's end-of-file — the key you press to close a shell, end `cat`'s input,
 * or leave a Python REPL. Binding it here takes that away.
 *
 * It is bound anyway, because it was asked for, and the loss is made good
 * rather than ignored: `Mod+Alt+D` sends a literal EOF to the shell. If the
 * trade is not worth it, `SPLIT_RIGHT` below is the one line to change.
 */

import { isMacOS } from "./platform";

export type ActionId =
  | "tab.new"
  | "tab.next"
  | "tab.prev"
  | "tab.byIndex"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.close"
  | "pane.zoom"
  | "pane.focusLeft"
  | "pane.focusRight"
  | "pane.focusUp"
  | "pane.focusDown"
  | "pane.growLeft"
  | "pane.growRight"
  | "pane.growUp"
  | "pane.growDown"
  | "window.fullscreen"
  | "terminal.eof"
  | "edit.copy"
  | "edit.paste";

interface Spec {
  id: ActionId;
  /** `Mod`, `Shift`, `Alt`, `Ctrl` and a key name, joined by `+`. */
  keys: string;
  label: string;
}

const SPLIT_RIGHT = "Mod+D";
const SPLIT_DOWN = "Mod+Shift+D";

/**
 * Copy and paste differ by platform for the same reason `Mod+D` is awkward:
 * on macOS `Cmd+C` is free, while everywhere else `Ctrl+C` is the interrupt and
 * must reach the shell, so terminals have always used `Ctrl+Shift+C`.
 */
const COPY = isMacOS() ? "Mod+C" : "Mod+Shift+C";
const PASTE = isMacOS() ? "Mod+V" : "Mod+Shift+V";

export const BINDINGS: Spec[] = [
  { id: "tab.new", keys: "Mod+T", label: "New tab" },
  { id: "tab.next", keys: "Ctrl+Tab", label: "Next tab" },
  { id: "tab.prev", keys: "Ctrl+Shift+Tab", label: "Previous tab" },

  { id: "pane.splitRight", keys: SPLIT_RIGHT, label: "Split right" },
  { id: "pane.splitDown", keys: SPLIT_DOWN, label: "Split down" },
  { id: "pane.close", keys: "Mod+Shift+W", label: "Close pane" },
  { id: "pane.zoom", keys: "Mod+Enter", label: "Zoom pane" },

  { id: "pane.focusLeft", keys: "Mod+Alt+ArrowLeft", label: "Focus pane left" },
  { id: "pane.focusRight", keys: "Mod+Alt+ArrowRight", label: "Focus pane right" },
  { id: "pane.focusUp", keys: "Mod+Alt+ArrowUp", label: "Focus pane up" },
  { id: "pane.focusDown", keys: "Mod+Alt+ArrowDown", label: "Focus pane down" },

  { id: "pane.growLeft", keys: "Mod+Shift+ArrowLeft", label: "Grow pane left" },
  { id: "pane.growRight", keys: "Mod+Shift+ArrowRight", label: "Grow pane right" },
  { id: "pane.growUp", keys: "Mod+Shift+ArrowUp", label: "Grow pane up" },
  { id: "pane.growDown", keys: "Mod+Shift+ArrowDown", label: "Grow pane down" },

  { id: "window.fullscreen", keys: "F11", label: "Full screen" },
  { id: "terminal.eof", keys: "Mod+Alt+D", label: "Send EOF to the shell" },

  { id: "edit.copy", keys: COPY, label: "Copy" },
  { id: "edit.paste", keys: PASTE, label: "Paste" },
];

interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function parse(keys: string): Chord {
  const parts = keys.split("+");
  const key = parts[parts.length - 1].toLowerCase();
  return {
    key,
    mod: parts.includes("Mod"),
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

const PARSED = BINDINGS.map((spec) => ({ ...spec, chord: parse(spec.keys) }));

function matches(chord: Chord, event: KeyboardEvent): boolean {
  const mod = isMacOS() ? event.metaKey : event.ctrlKey;
  // `Mod` and a literal `Ctrl` are the same key off macOS, so a binding that
  // asks for either is satisfied by it — but a binding that asks for neither
  // must not fire when it is held.
  const wantsMod = chord.mod || chord.ctrl;
  const heldMod = isMacOS() ? event.metaKey || event.ctrlKey : event.ctrlKey;
  if (wantsMod !== heldMod) return false;
  if (chord.mod && !mod && !isMacOS()) return false;
  if (chord.shift !== event.shiftKey) return false;
  if (chord.alt !== event.altKey) return false;

  const key = event.key.toLowerCase();
  // `event.code` is the fallback for layouts where a modifier changes `key`.
  return key === chord.key || event.code.toLowerCase() === `key${chord.key}`;
}

/**
 * Which action a key event triggers, if any.
 *
 * `Mod+1` … `Mod+9` are handled apart from the table because they are one
 * action taking an argument rather than nine actions.
 */
export function resolve(event: KeyboardEvent): { id: ActionId; index?: number } | null {
  const mod = isMacOS() ? event.metaKey : event.ctrlKey;
  if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
    return { id: "tab.byIndex", index: Number(event.key) - 1 };
  }

  for (const binding of PARSED) {
    if (matches(binding.chord, event)) return { id: binding.id };
  }
  return null;
}

/** Human-readable form for menus and the shortcut sheet. */
export function displayKeys(keys: string): string {
  const glyphs: Record<string, string> = isMacOS()
    ? { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" }
    : { Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl" };
  const names: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Enter: "↵",
    Tab: "⇥",
  };
  return keys
    .split("+")
    .map((part) => glyphs[part] ?? names[part] ?? part.toUpperCase())
    .join(isMacOS() ? "" : "+");
}

export function keysFor(id: ActionId): string {
  return BINDINGS.find((binding) => binding.id === id)?.keys ?? "";
}

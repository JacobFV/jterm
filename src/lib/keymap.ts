/**
 * Every keyboard shortcut, in one table — and the user's changes to it.
 *
 * `Mod` is Command on macOS and Control everywhere else.
 *
 * The table below is the *default*. Settings may override any row, and an
 * override of `""` means the action is deliberately unbound. Overrides arrive
 * through `setKeyOverrides` rather than by importing the settings store, which
 * keeps this module free of any dependency on where a preference is kept — it
 * is a lookup table, and the one thing a lookup table must not do is wait for
 * a disk read before it can answer.
 *
 * ── A note on Mod+D ──────────────────────────────────────────────────────
 * Splitting on `Mod+D` is borrowed from iTerm2, where it is `Cmd+D` and costs
 * nothing. On Windows and Linux the same shortcut is `Ctrl+D`, which is the
 * shell's end-of-file — the key you press to close a shell, end `cat`'s input,
 * or leave a Python REPL. Binding it here takes that away.
 *
 * It is bound anyway, because it was asked for, and the loss is made good
 * rather than ignored: `Mod+Alt+D` sends a literal EOF to the shell. Anyone who
 * disagrees with the trade can now simply rebind it in Settings, which is a
 * better answer than the one this comment used to give.
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
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "window.fullscreen"
  | "window.settings"
  | "terminal.eof"
  | "edit.copy"
  | "edit.paste";

/** Headings the shortcut list is grouped under, in the order they appear. */
export type ActionGroup = "Tabs" | "Panes" | "View" | "Window" | "Terminal";

export interface Spec {
  id: ActionId;
  /** `Mod`, `Shift`, `Alt`, `Ctrl` and a key name, joined by `+`. */
  keys: string;
  label: string;
  group: ActionGroup;
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
  { id: "tab.new", keys: "Mod+T", label: "New tab", group: "Tabs" },
  { id: "tab.next", keys: "Ctrl+Tab", label: "Next tab", group: "Tabs" },
  { id: "tab.prev", keys: "Ctrl+Shift+Tab", label: "Previous tab", group: "Tabs" },

  { id: "pane.splitRight", keys: SPLIT_RIGHT, label: "Split right", group: "Panes" },
  { id: "pane.splitDown", keys: SPLIT_DOWN, label: "Split down", group: "Panes" },
  { id: "pane.close", keys: "Mod+Shift+W", label: "Close pane", group: "Panes" },
  { id: "pane.zoom", keys: "Mod+Enter", label: "Zoom pane", group: "Panes" },

  { id: "pane.focusLeft", keys: "Mod+Alt+ArrowLeft", label: "Focus pane left", group: "Panes" },
  { id: "pane.focusRight", keys: "Mod+Alt+ArrowRight", label: "Focus pane right", group: "Panes" },
  { id: "pane.focusUp", keys: "Mod+Alt+ArrowUp", label: "Focus pane up", group: "Panes" },
  { id: "pane.focusDown", keys: "Mod+Alt+ArrowDown", label: "Focus pane down", group: "Panes" },

  { id: "pane.growLeft", keys: "Mod+Shift+ArrowLeft", label: "Grow pane left", group: "Panes" },
  { id: "pane.growRight", keys: "Mod+Shift+ArrowRight", label: "Grow pane right", group: "Panes" },
  { id: "pane.growUp", keys: "Mod+Shift+ArrowUp", label: "Grow pane up", group: "Panes" },
  { id: "pane.growDown", keys: "Mod+Shift+ArrowDown", label: "Grow pane down", group: "Panes" },

  // "Larger text" rather than "Zoom in", because `pane.zoom` above already
  // spends the word `zoom` on maximising a pane — tmux's meaning of it, and the
  // one a terminal's users arrive with. Two zooms in one shortcut table would
  // be a table you have to read twice.
  { id: "view.zoomIn", keys: "Mod+=", label: "Larger text", group: "View" },
  { id: "view.zoomOut", keys: "Mod+-", label: "Smaller text", group: "View" },
  { id: "view.zoomReset", keys: "Mod+0", label: "Default text size", group: "View" },

  { id: "window.fullscreen", keys: "F11", label: "Full screen", group: "Window" },
  { id: "window.settings", keys: "Mod+,", label: "Settings", group: "Window" },

  { id: "terminal.eof", keys: "Mod+Alt+D", label: "Send EOF to the shell", group: "Terminal" },
  { id: "edit.copy", keys: COPY, label: "Copy", group: "Terminal" },
  { id: "edit.paste", keys: PASTE, label: "Paste", group: "Terminal" },
];

export const ACTION_IDS: ActionId[] = BINDINGS.map((spec) => spec.id);

/**
 * Shortcuts the settings list shows but does not let you edit.
 *
 * `Mod+1` … `Mod+9` is one action taking an argument rather than nine actions,
 * so it has no single chord to rebind — but leaving it out of the list
 * altogether would make the list look wrong to anyone who uses it.
 */
export const FIXED_BINDINGS: { keys: string; label: string; group: ActionGroup }[] = [
  { keys: "Mod+1…9", label: "Select tab by number", group: "Tabs" },
];

/* ── Overrides ───────────────────────────────────────────────────────────── */

interface Chord {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * The key half of a chord, in the one spelling everything else compares
 * against. `event.key` for the space bar is a single space, which would
 * otherwise be indistinguishable from the separator in a stored binding.
 */
function normalizeKey(key: string): string {
  return key === " " ? "space" : key.toLowerCase();
}

/**
 * Keys that answer to more than one press.
 *
 * Zoom is why this exists. `Ctrl+=` and `Ctrl++` are one gesture on one key —
 * the second is the first with a finger on Shift — and every browser and editor
 * treats them as the same shortcut. So is the `+` on the numeric keypad, which
 * sends its own `code` and no Shift at all. A table that compared the character
 * exactly would answer perhaps a third of the presses aimed at it.
 *
 * `shifted` is the character the same physical key sends with Shift held, and
 * its presence is also what makes Shift optional for a chord on that key.
 * `codes` are physical keys that count as this key whatever the layout has
 * printed on them, which is what brings the keypad in — and what keeps `Mod+-`
 * reachable on a layout where `-` is somewhere else entirely.
 *
 * Only keys where this is genuinely one gesture belong here. It is not a
 * general "ignore Shift" escape hatch: `Mod+D` and `Mod+Shift+D` are two
 * different shortcuts and must stay that way.
 */
const ALIASES: Record<string, { shifted?: string; codes: string[] }> = {
  "=": { shifted: "+", codes: ["equal", "numpadadd"] },
  // Deliberately no `shifted` here, though `_` is what the key sends with Shift.
  // `Ctrl+_` is readline's **undo** — the thing bash does when you have mangled
  // a line and want it back — and nobody reaches for Shift to make something
  // smaller, since `-` needs no Shift to type in the first place. Taking that
  // key to save a keystroke nobody presses would be the `Ctrl+D` mistake again.
  "-": { codes: ["minus", "numpadsubtract"] },
  // `0` tolerates Shift for the layouts where the digit is *itself* the shifted
  // face of the key — AZERTY and QWERTZ both put punctuation on the number row
  // and ask for Shift to get a number. Nothing in a shell answers to `Ctrl+)`,
  // so this one costs nothing.
  "0": { shifted: ")", codes: ["digit0", "numpad0"] },
};

/** The unshifted key a shifted character shares its physical key with. */
const UNSHIFTED: Record<string, string> = Object.fromEntries(
  Object.entries(ALIASES)
    .filter(([, alias]) => alias.shifted !== undefined)
    .map(([key, alias]) => [alias.shifted!, key]),
);

function parse(keys: string): Chord {
  const parts = keys.split("+");
  return {
    key: normalizeKey(parts[parts.length - 1]),
    mod: parts.includes("Mod"),
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

interface Active {
  id: ActionId;
  keys: string;
  /** `null` when the action has been deliberately unbound. */
  chord: Chord | null;
}

let overrides: Partial<Record<ActionId, string>> = {};
let active: Active[] = compile();

function compile(): Active[] {
  return BINDINGS.map((spec) => {
    const keys = overrides[spec.id] ?? spec.keys;
    return { id: spec.id, keys, chord: keys ? parse(keys) : null };
  });
}

/**
 * Replace the user's bindings wholesale.
 *
 * Wholesale rather than one at a time because that is the shape the settings
 * file has: anything absent from the map is back to its default, which is also
 * how a "reset" is expressed — by removing the key rather than storing the
 * default under it.
 */
export function setKeyOverrides(next: Partial<Record<ActionId, string>>): void {
  overrides = next;
  active = compile();
}

/** The chord in force for an action: the user's if they set one, else ours. */
export function keysFor(id: ActionId): string {
  const override = overrides[id];
  if (override !== undefined) return override;
  return BINDINGS.find((binding) => binding.id === id)?.keys ?? "";
}

export function defaultKeysFor(id: ActionId): string {
  return BINDINGS.find((binding) => binding.id === id)?.keys ?? "";
}

/* ── Matching ────────────────────────────────────────────────────────────── */

function matches(chord: Chord, event: KeyboardEvent): boolean {
  const mod = isMacOS() ? event.metaKey : event.ctrlKey;
  // `Mod` and a literal `Ctrl` are the same key off macOS, so a binding that
  // asks for either is satisfied by it — but a binding that asks for neither
  // must not fire when it is held.
  const wantsMod = chord.mod || chord.ctrl;
  const heldMod = isMacOS() ? event.metaKey || event.ctrlKey : event.ctrlKey;
  if (wantsMod !== heldMod) return false;
  if (chord.mod && !mod && !isMacOS()) return false;
  if (chord.alt !== event.altKey) return false;

  const alias = ALIASES[chord.key];
  // Shift is part of a chord, except on a key where holding it is only how you
  // reach the character in the first place — see `ALIASES`.
  const shiftOptional = alias?.shifted !== undefined && !chord.shift;
  if (chord.shift !== event.shiftKey && !shiftOptional) return false;

  const key = normalizeKey(event.key);
  if (key === chord.key || key === alias?.shifted) return true;
  // `event.code` is the fallback for layouts where a modifier changes `key`.
  const code = event.code.toLowerCase();
  return code === `key${chord.key}` || (alias?.codes.includes(code) ?? false);
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

  for (const binding of active) {
    if (binding.chord !== null && matches(binding.chord, event)) return { id: binding.id };
  }
  return null;
}

/* ── Recording a new one ─────────────────────────────────────────────────── */

/**
 * The chord a key press describes, written the way this file stores them.
 *
 * Returns `null` for a press that cannot stand on its own: a bare modifier,
 * which arrives while the user is still reaching for the real key.
 *
 * A character that is the shifted face of an aliased key is written down as the
 * key itself, with the Shift dropped — pressing `Ctrl+Shift+=` records `Mod+=`.
 * That is the same press as far as `matches` is concerned, so recording it any
 * other way would store a chord that answers fewer presses than the one the
 * user just performed. It also keeps `+` out of the stored form, which matters
 * because `+` is the separator and so cannot also be a key name.
 */
export function chordFromEvent(event: KeyboardEvent): string | null {
  const raw = event.key;
  if (raw === "Control" || raw === "Shift" || raw === "Alt" || raw === "Meta") return null;

  const folded = UNSHIFTED[raw];
  const key = folded ?? raw;

  const parts: string[] = [];
  if (isMacOS()) {
    if (event.metaKey) parts.push("Mod");
    if (event.ctrlKey) parts.push("Ctrl");
  } else if (event.ctrlKey) {
    parts.push("Mod");
  }
  if (event.shiftKey && folded === undefined) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  parts.push(key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

/** Whether two written chords would be triggered by the same key press. */
export function sameChord(a: string, b: string): boolean {
  if (!a || !b) return false;
  const first = parse(a);
  const second = parse(b);
  return (
    first.key === second.key &&
    first.mod === second.mod &&
    first.ctrl === second.ctrl &&
    first.shift === second.shift &&
    first.alt === second.alt
  );
}

/**
 * The action `keys` is already taken by, if any.
 *
 * Two actions on one chord is not an error the app can resolve at the moment
 * the key is pressed — `resolve` would simply pick whichever came first in the
 * table, which is arbitrary. So it is resolved at the moment the binding is
 * made instead, which is the only point where the user is present to be told.
 */
export function conflictingAction(keys: string, except: ActionId): ActionId | null {
  for (const spec of BINDINGS) {
    if (spec.id === except) continue;
    if (sameChord(keysFor(spec.id), keys)) return spec.id;
  }
  return null;
}

export function labelFor(id: ActionId): string {
  return BINDINGS.find((binding) => binding.id === id)?.label ?? id;
}

/** Human-readable form for menus and the shortcut sheet. */
export function displayKeys(keys: string): string {
  if (!keys) return "—";
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
    Escape: "Esc",
    Space: "Space",
  };
  return keys
    .split("+")
    .map((part) => glyphs[part] ?? names[part] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join(isMacOS() ? "" : "+");
}

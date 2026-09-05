/**
 * Following a URL that a program printed in a terminal.
 *
 * Two rules, and both of them are about not doing something the user did not
 * ask for:
 *
 *   - **A modifier is required.** A terminal is a surface people click on all
 *     day to focus a pane or to start a selection, and a bare click that
 *     launched a browser would go off constantly by accident — over a log full
 *     of URLs it would be a minefield. `Mod`+click is what every terminal
 *     emulator asks for, so it is what this asks for.
 *   - **Only `http:` and `https:` leave the app.** Both the text-scanned links
 *     and the ones a program declares with OSC 8 are, in the end, bytes some
 *     other process chose. Handing an arbitrary scheme to the desktop is
 *     handing it a way to start a program; a URL that is not a web address is
 *     simply not followed.
 */

import { isMacOS } from "./platform";

/** Schemes that may be handed to the user's browser. */
const ALLOWED = new Set(["http:", "https:"]);

/**
 * The subset of a mouse event this decision needs.
 *
 * Written as a shape rather than `MouseEvent` so the rule can be tested in a
 * plain Node environment, where there is no such class.
 */
export interface LinkClick {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Whether a click on a link was asking to open it.
 *
 * Platform-split for the same reason `keymap` splits: `Mod` is ⌘ on macOS and
 * Ctrl everywhere else. On macOS the difference is not cosmetic — Ctrl+click
 * *is* the secondary click there, so honouring it would open a link every time
 * someone reached for the context menu.
 */
export function isLinkActivation(event: LinkClick): boolean {
  if (event.button !== 0) return false;
  return isMacOS() ? event.metaKey : event.ctrlKey && !event.metaKey;
}

/**
 * The address to hand over, or `null` for one this app will not follow.
 *
 * Returns the parsed `href` rather than the original text so that what reaches
 * the opener is what a URL parser made of it, not a string that merely looked
 * like one.
 */
export function linkTarget(uri: string): string | null {
  try {
    const url = new URL(uri.trim());
    return ALLOWED.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

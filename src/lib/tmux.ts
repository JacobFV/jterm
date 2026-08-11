/**
 * Which panes are in tmux, and what jterm's own shortcuts mean when they are.
 *
 * The design decision this file exists to hold: **tmux owns splits, jterm owns
 * tabs.** A tmux-backed pane forwards `Mod+D`, the focus moves and the resizes
 * to tmux, so the muscle memory keeps working and the split lands where the
 * durable session is. Tabs are not forwarded at all — a jterm tab is a window
 * of the app, not a tmux window, and `Mod+T` opening a tmux window would make
 * the tab strip a lie.
 *
 * Two kinds of session end up here and they are not treated alike:
 *
 *   - **jterm's own**, named `jterm-<pane>`, one per pane, created because the
 *     tmux backend is switched on. Closing the pane ends the session, because
 *     closing a pane means the shell is finished with. Quitting or crashing
 *     does not, which is the entire point.
 *   - **the user's**, attached to by name from the session picker. Closing the
 *     pane detaches and leaves the session exactly as it was. jterm never ends
 *     a session it did not create.
 *
 * `OWN_PREFIX` is what tells the two apart, so it is not decoration.
 */

import { tmuxControl as controlApi, tmux as tmuxApi } from "./ipc";
import type { ActionId } from "./keymap";

const OWN_PREFIX = "jterm-";

/**
 * The session jterm would make for a pane.
 *
 * Derived from the pane id rather than stored, so the name a restored pane
 * reattaches to is the one it left behind even if the snapshot lost the field.
 * Truncated because a session name shows up in tmux's own status line and every
 * `list-sessions` the user runs, and 18 hex characters there is noise.
 */
export function sessionNameFor(paneId: string): string {
  return `${OWN_PREFIX}${paneId.slice(0, 8)}`;
}

/** Whether `session` is one jterm made for this pane, and may therefore end. */
export function isOwnSession(paneId: string, session: string): boolean {
  return session === sessionNameFor(paneId);
}

/**
 * Whether a session looks like one jterm made for *some* pane.
 *
 * Weaker than `isOwnSession` on purpose, and used only to label a row in the
 * session list, which has no pane in mind. Nothing is ever ended on the
 * strength of this — a user is perfectly entitled to name a session
 * `jterm-whatever` themselves, and it would not be jterm's to kill.
 */
export function looksLikeOwnSession(session: string): boolean {
  return session.startsWith(OWN_PREFIX);
}

/**
 * Is tmux on this machine, asked once.
 *
 * Cached as the promise rather than the answer, so the several callers racing
 * at startup share one round trip instead of each making their own.
 */
let availability: Promise<boolean> | null = null;

export function tmuxAvailable(): Promise<boolean> {
  if (availability === null) availability = tmuxApi.available();
  return availability;
}

/* ── Which shortcuts tmux takes ──────────────────────────────────────────── */

/**
 * jterm's pane actions, in tmux's words.
 *
 * `pane.close` is deliberately absent. `Mod+Shift+W` means "close this pane of
 * jterm" everywhere else in the app, and routing it to `kill-pane` would, on a
 * session with one pane left, destroy the session and leave a jterm pane behind
 * showing a dead shell — a keystroke that does not close the thing it is aimed
 * at. Closing the pane is what ends the session, by way of `disposeSession`.
 */
const TMUX_ACTIONS: Partial<Record<ActionId, string>> = {
  "pane.splitRight": "split-right",
  "pane.splitDown": "split-down",
  "pane.zoom": "zoom",
  "pane.focusLeft": "focus-left",
  "pane.focusRight": "focus-right",
  "pane.focusUp": "focus-up",
  "pane.focusDown": "focus-down",
  "pane.growLeft": "grow-left",
  "pane.growRight": "grow-right",
  "pane.growUp": "grow-up",
  "pane.growDown": "grow-down",
};

export function isTmuxAction(id: ActionId): boolean {
  return id in TMUX_ACTIONS;
}

/**
 * Offer an action to tmux. Resolves to whether tmux took it.
 *
 * `false` means the caller should carry on and do the jterm thing — which is
 * how moving the focus off the edge of a tmux layout arrives at the jterm pane
 * next door rather than stopping dead at the boundary between the two.
 */
export async function runTmuxAction(session: string, id: ActionId): Promise<boolean> {
  const action = TMUX_ACTIONS[id];
  if (action === undefined) return false;
  return tmuxApi.paneCommand(session, action);
}

/**
 * The same, for a pane jterm is drawing on tmux's behalf.
 *
 * Aimed at the pane rather than at the session, because in control mode jterm
 * knows exactly which tmux pane the user is looking at — it drew it. That
 * removes the one piece of guesswork in the other path, where "the session's
 * current pane" has to stand in for "the pane you are in".
 */
export async function runControlAction(pane: string, id: ActionId): Promise<boolean> {
  const action = TMUX_ACTIONS[id];
  if (action === undefined) return false;
  return controlApi.paneCommand(pane, action);
}

/**
 * End the session behind a pane that is closing, if it was jterm's to end.
 *
 * Called from the pane registry's `dispose`, which runs when a pane is closed
 * for good and not on an ordinary unmount — so quitting the app leaves every
 * session running, and only a deliberate close takes one down.
 */
export function disposeSession(paneId: string, session: string | undefined): void {
  if (!session || !isOwnSession(paneId, session)) return;
  void tmuxApi.killSession(session);
}

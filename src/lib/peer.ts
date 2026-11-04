/**
 * Another jterm's window, drawn here as that window.
 *
 * Opening a remote host's sessions one by one (see `lib/remote.ts`) gives one
 * tab per tmux window, which on a peer running jterm is one tab per *pane*: the
 * four tabs and nine splits arranged over there arrive as nine flat tabs here.
 * The arrangement is not in tmux at all — it is in the peer's own session
 * snapshot, which names each pane's tmux session. So that file is read over
 * ssh, and its tabs are rebuilt here with the same splits, the same ratios and
 * the same titles, each leaf a control-mode pane on the session it names.
 *
 * The peer is the authority, as tmux is for an ordinary control session. Its
 * layout is read again every so often, and a tab here follows what the tab
 * there became. A divider dragged here is put back on the next read; that is
 * the cost of the two windows agreeing, and the alternative is two windows that
 * slowly stop being the same window.
 *
 * Only what can be drawn is drawn. A peer's notepad, browser or plain shell has
 * nothing behind it that this machine can reach, and a jterm pane whose session
 * the user has split inside tmux is not one pane any more — so those leaves are
 * left out and their splits collapse around them, and a tab with nothing left
 * is not shown. The session with more than one pane still arrives on its own,
 * the ordinary way, as its own tab.
 *
 * Everything here is pure, and the ids are derived: the same peer pane is the
 * same pane here on every read, so a refresh moves rectangles rather than
 * remounting terminals.
 */

import type { Node } from "@/state/tree";
import { removePane } from "@/state/tree";
import { decode } from "@/state/snapshot";
import type { PaneState, Tab } from "@/state/workspace";
import type { PeerLayout } from "./ipc";
import { remoteKey } from "./remote";
import { PEER_TAB_PREFIX, controlPaneId, isPeerTabId } from "./tmuxControl";

function sanitize(text: string): string {
  return Array.from(text)
    .map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "-"))
    .slice(0, 32)
    .join("");
}

/** Every tab mirrored from `host` has an id starting with this. */
export function peerTabPrefix(host: string): string {
  return `${PEER_TAB_PREFIX}${sanitize(host)}-`;
}

export function isPeerTab(tab: Tab): boolean {
  return isPeerTabId(tab.id);
}

export interface Mirror {
  tabs: Tab[];
  /** The control sessions the tabs draw from, as `host:name` keys. */
  sessions: string[];
  /** The tab that was in front over there, if it is one of these. */
  activeTabId: string | null;
}

/**
 * The peer's main window as tabs here.
 *
 * `skip` holds sessions the user has detached from: those leaves are left out,
 * so a refresh does not put back what was deliberately put away.
 */
export function mirrorTabs(
  host: string,
  layout: PeerLayout,
  skip: ReadonlySet<string> = new Set(),
): Mirror {
  const snapshot = decode(layout.snapshot);
  if (!snapshot) return { tabs: [], sessions: [], activeTabId: null };

  // A session is drawable as one leaf only when it is exactly one tmux pane.
  const paneCounts = new Map<string, number>();
  const paneOf = new Map<string, string>();
  for (const { session, pane } of layout.panes) {
    paneCounts.set(session, (paneCounts.get(session) ?? 0) + 1);
    paneOf.set(session, pane);
  }

  const prefix = peerTabPrefix(host);
  const sessions = new Set<string>();
  const tabs: Tab[] = [];
  let activeTabId: string | null = null;

  for (const remote of snapshot.workspace.tabs) {
    const id = `${prefix}${remote.id}`;
    const panes: Record<string, PaneState> = {};
    const renamed = new Map<string, string>();
    let root: Node | null = remote.root;

    for (const pane of Object.values(remote.panes)) {
      const name = pane.kind === "terminal" ? pane.tmux : undefined;
      const tmuxPane = name === undefined ? undefined : paneOf.get(name);
      const key = name === undefined ? undefined : remoteKey(host, name);
      const drawable =
        pane.kind === "terminal" &&
        name !== undefined &&
        // `tmuxPane` set over there means the peer is itself drawing someone
        // else's tmux; that is not a pane of its own to mirror.
        pane.tmuxPane === undefined &&
        paneCounts.get(name) === 1 &&
        tmuxPane !== undefined &&
        key !== undefined &&
        !skip.has(key);
      if (!drawable) {
        root = root === null ? null : removePane(root, pane.id);
        continue;
      }
      const localId = controlPaneId(key!, tmuxPane!);
      renamed.set(pane.id, localId);
      sessions.add(key!);
      panes[localId] = {
        id: localId,
        kind: "terminal",
        tmux: key!,
        tmuxPane: tmuxPane!,
        // What names the pane over there names it here. Not the agent record:
        // that is for resuming a conversation on the machine that had it.
        ...(pane.name !== undefined ? { name: pane.name } : {}),
        ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
        ...(pane.command !== undefined ? { command: pane.command } : {}),
        ...(pane.theme !== undefined ? { theme: pane.theme } : {}),
      };
    }
    if (root === null) continue;

    const focused = renamed.get(remote.focusedPaneId) ?? Object.keys(panes)[0];
    tabs.push({
      id,
      ...(remote.title !== undefined ? { title: remote.title } : {}),
      ...(remote.theme !== undefined ? { theme: remote.theme } : {}),
      ...(remote.profile !== undefined ? { profile: remote.profile } : {}),
      root: rename(root, id, renamed),
      panes,
      focusedPaneId: focused,
      zoomedPaneId: null,
    });
    if (remote.id === snapshot.workspace.activeTabId) activeTabId = id;
  }

  return { tabs, sessions: [...sessions], activeTabId };
}

/** The peer's tree with its leaves pointed at the panes here, and its node ids
 *  namespaced by the tab so two peers' trees never share one. */
function rename(node: Node, tabId: string, panes: Map<string, string>): Node {
  if (node.kind === "leaf") {
    return { ...node, id: `${tabId}-${node.id}`, paneId: panes.get(node.paneId) ?? node.paneId };
  }
  return {
    ...node,
    id: `${tabId}-${node.id}`,
    children: [rename(node.children[0], tabId, panes), rename(node.children[1], tabId, panes)],
  };
}

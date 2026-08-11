/**
 * Control mode on the frontend: tmux's shape, turned into jterm's.
 *
 * The Rust side (`src-tauri/src/control.rs`) speaks the protocol and hands over
 * a layout tree that still has tmux's shape. The one real conversion left is
 * here, and it is a shape mismatch rather than a parsing problem:
 *
 *   **tmux's splits are n-ary; jterm's are binary.** tmux is happy to put three
 *   panes in a row as one split with three children. jterm's tree has exactly
 *   two children per split, because a divider sits between a pair and a drag
 *   has to mean something. So a run of n children becomes n-1 nested splits,
 *   right-leaning, with each ratio worked out against *what is left* rather
 *   than against the whole — which is what makes the arithmetic come out at the
 *   same pixels tmux had in mind.
 *
 * Everything here is derived, never allocated. The same tmux pane is the same
 * jterm pane id and the same tab id on every refresh, which is the property the
 * whole feature rests on: `Workspace` renders panes from a flat list keyed by
 * id, so a layout change moves rectangles instead of unmounting terminals. Give
 * a pane a fresh id on each refresh and every tmux split would kill and restart
 * every shell on screen.
 */

import { type Node, leaf } from "@/state/tree";
import type { PaneState } from "@/state/workspace";

/** A pane in tmux's layout, as `control.rs` serialises it. */
export interface TmuxPaneNode {
  kind: "pane";
  /** The jterm pane id, decided in Rust so both ends agree without asking. */
  id: string;
  /** tmux's own id, as `%3`. */
  tmux: string;
  width: number;
  height: number;
}

export interface TmuxSplitNode {
  kind: "split";
  /** `x` for panes side by side, `y` for panes stacked. */
  axis: "x" | "y";
  width: number;
  height: number;
  children: TmuxLayoutNode[];
}

export type TmuxLayoutNode = TmuxPaneNode | TmuxSplitNode;

export interface TmuxWindow {
  /** tmux's window id, as `@0`. */
  id: string;
  name: string;
  active: boolean;
  layout: TmuxLayoutNode;
}

export interface TmuxSessionShape {
  session: string;
  windows: TmuxWindow[];
}

/** Kept in step with `pane_key` in `control.rs`, which owns the real rule. */
function sanitize(session: string): string {
  return Array.from(session)
    .map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "-"))
    .slice(0, 32)
    .join("");
}

/**
 * The jterm tab standing for a tmux window.
 *
 * Derived from the two ids so a window keeps its tab across refreshes, across a
 * detach and reattach, and across a restart of the app — the tab a user has
 * dragged to third position stays third when tmux mentions it again.
 */
export function windowTabId(session: string, windowId: string): string {
  return `tmuxwin-${sanitize(session)}-${windowId.replace(/^@/, "")}`;
}

/** Whether a tab id belongs to a control session — used to strip them from the
 *  snapshot, since tmux is the thing that remembers them. */
export function isControlTabId(tabId: string): boolean {
  return tabId.startsWith("tmuxwin-");
}

/* ── The tree ────────────────────────────────────────────────────────────── */

/** A node's extent along an axis: what the ratios are shares of. */
function extent(node: TmuxLayoutNode, axis: "x" | "y"): number {
  return Math.max(1, axis === "x" ? node.width : node.height);
}

/**
 * tmux's layout as a jterm split tree.
 *
 * `path` accumulates the position in the tree and becomes each split's id, so
 * the divider between the same two panes is the same divider between refreshes
 * and a drag in progress is not interrupted by one.
 */
export function toNode(layout: TmuxLayoutNode, path: string): Node {
  if (layout.kind === "pane") return leaf(`${path}-l`, layout.id);

  return fold(layout.children, layout.axis, path, 0);
}

/**
 * Fold `children[from..]` into a right-leaning chain of binary splits.
 *
 * The ratio at each step is the first child's share of *everything still to be
 * placed*, not of the original whole — three equal panes are 1/3 and then 1/2,
 * which lands them in thirds. Sharing them 1/3 and 1/3 would not.
 */
function fold(
  children: TmuxLayoutNode[],
  axis: "x" | "y",
  path: string,
  from: number,
): Node {
  const child = children[from];
  if (from === children.length - 1) return toNode(child, `${path}-${from}`);

  let remaining = 0;
  for (let at = from; at < children.length; at += 1) remaining += extent(children[at], axis);

  return {
    kind: "split",
    id: `${path}-s${from}`,
    axis,
    ratio: extent(child, axis) / remaining,
    children: [toNode(child, `${path}-${from}`), fold(children, axis, path, from + 1)],
  };
}

/** Every pane in a tmux layout, in the order they appear. */
export function panesOf(layout: TmuxLayoutNode): TmuxPaneNode[] {
  if (layout.kind === "pane") return [layout];
  return layout.children.flatMap(panesOf);
}

/**
 * The jterm panes a tmux window's layout calls for.
 *
 * `tmux` and `tmuxPane` together are what mark a pane as control-mode: the
 * session name alone means tmux is running *inside* an ordinary pane, which is
 * the other integration entirely and behaves differently in `TerminalPane`.
 */
export function panesFor(
  session: string,
  layout: TmuxLayoutNode,
): Record<string, PaneState> {
  const panes: Record<string, PaneState> = {};
  for (const pane of panesOf(layout)) {
    panes[pane.id] = {
      id: pane.id,
      kind: "terminal",
      tmux: session,
      tmuxPane: pane.tmux,
    };
  }
  return panes;
}

/**
 * The split layout inside a tab: a binary tree of panes.
 *
 * Everything here is pure and returns new trees rather than mutating, which
 * matters more than it usually does. A pane is a *live shell*: the React
 * component that owns it must not unmount when the layout changes, or the
 * terminal is destroyed and the process behind it orphaned. Keeping the tree
 * as plain data lets `layout()` turn it into a flat list of rectangles, so the
 * components can be rendered from a stable, unchanging list and only their
 * positions move. Rearranging panes then costs a style recalculation instead of
 * a teardown.
 *
 * `ratio` is the fraction of the split given to the *first* child, so a fresh
 * even split is 0.5 and dragging the divider left lowers it.
 */

export type Axis = "x" | "y";

/** A pane occupying a rectangle. `paneId` indexes the tab's pane map. */
export interface LeafNode {
  kind: "leaf";
  id: string;
  paneId: string;
}

export interface SplitNode {
  kind: "split";
  id: string;
  /** `x` places children side by side; `y` stacks them. */
  axis: Axis;
  /** Share of the split belonging to `children[0]`, clamped to [MIN, 1-MIN]. */
  ratio: number;
  children: [Node, Node];
}

export type Node = LeafNode | SplitNode;

/** Percentages of the containing area, so layout is resolution independent. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PaneBox {
  paneId: string;
  rect: Rect;
}

export interface DividerBox {
  /** The split whose ratio this divider edits. */
  nodeId: string;
  axis: Axis;
  /** The split's own rectangle; the drag maps a pointer position into it. */
  rect: Rect;
  ratio: number;
}

export interface Layout {
  panes: PaneBox[];
  dividers: DividerBox[];
}

/**
 * Smallest share a pane may be dragged to.
 *
 * Not zero: a pane squeezed to nothing still has a running shell in it, and a
 * pane you cannot see is a pane you cannot get back to.
 */
export const MIN_RATIO = 0.08;

export const FULL_RECT: Rect = { left: 0, top: 0, width: 100, height: 100 };

export function leaf(id: string, paneId: string): LeafNode {
  return { kind: "leaf", id, paneId };
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export function paneIds(node: Node): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return [...paneIds(node.children[0]), ...paneIds(node.children[1])];
}

export function countPanes(node: Node): number {
  return node.kind === "leaf" ? 1 : countPanes(node.children[0]) + countPanes(node.children[1]);
}

export function hasPane(node: Node, paneId: string): boolean {
  if (node.kind === "leaf") return node.paneId === paneId;
  return hasPane(node.children[0], paneId) || hasPane(node.children[1], paneId);
}

/* ── Layout ──────────────────────────────────────────────────────────────── */

/**
 * Flatten the tree into absolute rectangles.
 *
 * Splits consume no space of their own — the divider is drawn *over* the seam
 * rather than between the children — so sibling rectangles meet exactly. A
 * gutter here would compound down the tree and leave uneven margins at
 * different depths.
 */
export function layout(node: Node, rect: Rect = FULL_RECT): Layout {
  const panes: PaneBox[] = [];
  const dividers: DividerBox[] = [];

  const walk = (current: Node, area: Rect) => {
    if (current.kind === "leaf") {
      panes.push({ paneId: current.paneId, rect: area });
      return;
    }
    const ratio = clampRatio(current.ratio);
    if (current.axis === "x") {
      const first = area.width * ratio;
      walk(current.children[0], { ...area, width: first });
      walk(current.children[1], {
        ...area,
        left: area.left + first,
        width: area.width - first,
      });
    } else {
      const first = area.height * ratio;
      walk(current.children[0], { ...area, height: first });
      walk(current.children[1], {
        ...area,
        top: area.top + first,
        height: area.height - first,
      });
    }
    dividers.push({ nodeId: current.id, axis: current.axis, rect: area, ratio });
  };

  walk(node, rect);
  return { panes, dividers };
}

/* ── Editing ─────────────────────────────────────────────────────────────── */

/** Replace the leaf holding `paneId`, or return the tree unchanged. */
function replaceLeaf(node: Node, paneId: string, make: (leafNode: LeafNode) => Node): Node {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? make(node) : node;
  }
  const first = replaceLeaf(node.children[0], paneId, make);
  const second = replaceLeaf(node.children[1], paneId, make);
  if (first === node.children[0] && second === node.children[1]) return node;
  return { ...node, children: [first, second] };
}

/**
 * Put a whole tree beside the pane holding `targetPaneId`.
 *
 * The pane's slot becomes a split, with the pane on one side and `subtree` —
 * which may be a single leaf or an entire layout — on the other. That
 * generality is what lets a tab be dropped into another tab's workspace: the
 * tab's panes arrive with the arrangement they already had, nested inside the
 * half they were dropped into, rather than being flattened into siblings.
 *
 * The caller supplies `splitId`, because ids are minted where the rest of the
 * app's ids are minted and this file stays pure.
 */
export function graftTree(
  root: Node,
  targetPaneId: string,
  axis: Axis,
  subtree: Node,
  splitId: string,
  before = false,
): Node {
  return replaceLeaf(root, targetPaneId, (existing) => ({
    kind: "split",
    id: splitId,
    axis,
    ratio: 0.5,
    children: before ? [subtree, existing] : [existing, subtree],
  }));
}

/**
 * Split the pane holding `targetPaneId`, putting `newPaneId` after it (to the
 * right for `x`, below for `y`) or before it when `before` is set.
 */
export function splitPane(
  root: Node,
  targetPaneId: string,
  axis: Axis,
  newPaneId: string,
  newNodeIds: { split: string; leaf: string },
  before = false,
): Node {
  return graftTree(
    root,
    targetPaneId,
    axis,
    leaf(newNodeIds.leaf, newPaneId),
    newNodeIds.split,
    before,
  );
}

/**
 * Remove a pane, collapsing the split it was half of.
 *
 * Returns `null` when the pane was the last one — the caller decides whether
 * that closes the tab, which is not a layout question.
 */
export function removePane(root: Node, paneId: string): Node | null {
  if (root.kind === "leaf") {
    return root.paneId === paneId ? null : root;
  }
  const [first, second] = root.children;
  const nextFirst = removePane(first, paneId);
  if (nextFirst === null) return second;
  const nextSecond = removePane(second, paneId);
  if (nextSecond === null) return nextFirst;
  if (nextFirst === first && nextSecond === second) return root;
  return { ...root, children: [nextFirst, nextSecond] };
}

/**
 * Point the leaf holding `paneId` at a different pane, leaving the shape of the
 * tree alone. Used when a pane is replaced by another kind of pane in place —
 * the split it was half of is not the thing being changed.
 */
export function repointPane(root: Node, paneId: string, nextPaneId: string): Node {
  return replaceLeaf(root, paneId, (existing) => ({ ...existing, paneId: nextPaneId }));
}

/**
 * Put a whole tree where a single pane was.
 *
 * The mirror of `graftTree`: that one puts a subtree *beside* a pane, this one
 * puts it *instead of* it. The displaced pane is not the tree's problem — the
 * caller decides where it goes.
 */
export function substituteTree(root: Node, paneId: string, subtree: Node): Node {
  return replaceLeaf(root, paneId, () => subtree);
}

export function setRatio(root: Node, nodeId: string, ratio: number): Node {
  if (root.kind === "leaf") return root;
  if (root.id === nodeId) return { ...root, ratio: clampRatio(ratio) };
  const first = setRatio(root.children[0], nodeId, ratio);
  const second = setRatio(root.children[1], nodeId, ratio);
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

/** Where a dragged pane is being dropped, relative to the pane under it. */
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

/**
 * Move `paneId` next to `targetPaneId`.
 *
 * `center` swaps the two panes in place, which is the only rearrangement that
 * keeps the layout's shape — useful when the split you have is the split you
 * want and only the contents are in the wrong order.
 *
 * The removal happens first so a drop onto a sibling collapses the old split
 * before the new one is made; doing it the other way round would briefly hold
 * the pane in two places and leave a stale empty branch behind.
 */
export function movePane(
  root: Node,
  paneId: string,
  targetPaneId: string,
  edge: DropEdge,
  newNodeIds: { split: string; leaf: string },
): Node {
  if (paneId === targetPaneId) return root;

  if (edge === "center") {
    return swapPanes(root, paneId, targetPaneId);
  }

  const pruned = removePane(root, paneId);
  // Only reachable if the tree held a single pane, in which case there is no
  // second pane to have dropped onto.
  if (pruned === null) return root;
  if (!hasPane(pruned, targetPaneId)) return root;

  const axis: Axis = edge === "left" || edge === "right" ? "x" : "y";
  const before = edge === "left" || edge === "top";
  return splitPane(pruned, targetPaneId, axis, paneId, newNodeIds, before);
}

export function swapPanes(root: Node, a: string, b: string): Node {
  if (root.kind === "leaf") {
    if (root.paneId === a) return { ...root, paneId: b };
    if (root.paneId === b) return { ...root, paneId: a };
    return root;
  }
  const first = swapPanes(root.children[0], a, b);
  const second = swapPanes(root.children[1], a, b);
  if (first === root.children[0] && second === root.children[1]) return root;
  return { ...root, children: [first, second] };
}

/* ── Directional focus ───────────────────────────────────────────────────── */

export type Direction = "left" | "right" | "up" | "down";

/**
 * A direction read as a split: which axis it divides, and which side of the
 * existing pane the new one lands on.
 *
 * Splits are described by an axis and a `before` flag because that is what the
 * tree needs, but "down" is what a person means. One conversion, shared by
 * everything that has a direction and wants a split.
 */
export function splitPlacement(direction: Direction): { axis: Axis; before: boolean } {
  return {
    axis: direction === "left" || direction === "right" ? "x" : "y",
    before: direction === "left" || direction === "up",
  };
}

/**
 * The pane a directional focus move should land on, by geometry rather than by
 * walking the tree.
 *
 * Tree-walking gives surprising answers in deep layouts — "up" can cross to the
 * far side of the window because that is where the parent split happens to
 * lead. Choosing the nearest pane that actually touches the current one in the
 * requested direction is what the user means by "up".
 */
export function neighbor(
  panes: PaneBox[],
  fromPaneId: string,
  direction: Direction,
): string | null {
  const from = panes.find((pane) => pane.paneId === fromPaneId);
  if (!from) return null;

  const horizontal = direction === "left" || direction === "right";
  const edge =
    direction === "left"
      ? from.rect.left
      : direction === "right"
        ? from.rect.left + from.rect.width
        : direction === "up"
          ? from.rect.top
          : from.rect.top + from.rect.height;

  // Overlap along the perpendicular axis is what "touching" means here: a pane
  // diagonally offset from this one is not to its left, however close it is.
  const spanStart = horizontal ? from.rect.top : from.rect.left;
  const spanEnd = spanStart + (horizontal ? from.rect.height : from.rect.width);

  let best: { paneId: string; distance: number; overlap: number } | null = null;

  for (const pane of panes) {
    if (pane.paneId === fromPaneId) continue;

    const near = horizontal ? pane.rect.left : pane.rect.top;
    const far = near + (horizontal ? pane.rect.width : pane.rect.height);
    const distance =
      direction === "left" || direction === "up" ? edge - far : near - edge;
    // A small negative distance is the shared seam, not an overlap.
    if (distance < -0.01) continue;

    const otherStart = horizontal ? pane.rect.top : pane.rect.left;
    const otherEnd = otherStart + (horizontal ? pane.rect.height : pane.rect.width);
    const overlap = Math.min(spanEnd, otherEnd) - Math.max(spanStart, otherStart);
    if (overlap <= 0.01) continue;

    if (
      best === null ||
      distance < best.distance - 0.01 ||
      // Ties go to the pane that shares the most edge, which is the one that
      // looks like the obvious neighbour.
      (Math.abs(distance - best.distance) <= 0.01 && overlap > best.overlap)
    ) {
      best = { paneId: pane.paneId, distance, overlap };
    }
  }

  return best?.paneId ?? null;
}

/**
 * The split a keyboard resize should act on, and which way its ratio moves.
 *
 * "Resize left" reads as *grow this pane leftwards*, and a pane can only grow
 * towards a divider it actually touches on that side. So the split we want is
 * not merely the innermost one on the right axis — it is the innermost one on
 * the right axis with the pane on the right *side* of it:
 *
 *   - growing right or down needs the pane to be the split's first child, with
 *     the divider after it, and pushes the ratio up;
 *   - growing left or up needs it to be the second child, with the divider
 *     before it, and pushes the ratio down.
 *
 * When no ancestor qualifies the pane is already against that edge of the
 * window, and `null` correctly means "nothing to do" rather than "move some
 * other divider instead".
 */
export function resizeTarget(
  root: Node,
  paneId: string,
  direction: Direction,
): { nodeId: string; delta: number } | null {
  const axis: Axis = direction === "left" || direction === "right" ? "x" : "y";
  const forward = direction === "right" || direction === "down";
  const wantBranch: 0 | 1 = forward ? 0 : 1;

  const path = pathTo(root, paneId);
  if (path === null) return null;

  // Innermost first: that divider is the one nearest the pane, and the one the
  // user is looking at when they press the key.
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const { node, branch } = path[index];
    if (node.axis !== axis || branch !== wantBranch) continue;
    return { nodeId: node.id, delta: forward ? 1 : -1 };
  }
  return null;
}

/** Splits from the root down to `paneId`, with the child index taken at each. */
function pathTo(
  root: Node,
  paneId: string,
): { node: SplitNode; branch: 0 | 1 }[] | null {
  if (root.kind === "leaf") return root.paneId === paneId ? [] : null;
  for (const branch of [0, 1] as const) {
    const below = pathTo(root.children[branch], paneId);
    if (below !== null) return [{ node: root, branch }, ...below];
  }
  return null;
}

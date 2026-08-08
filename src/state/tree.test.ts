import { describe, expect, it } from "vitest";
import {
  type Node,
  countPanes,
  graftTree,
  layout,
  leaf,
  movePane,
  neighbor,
  paneIds,
  removePane,
  repointPane,
  resizeTarget,
  setRatio,
  splitPane,
  splitPlacement,
  substituteTree,
} from "./tree";

const ids = (n: number) => ({ split: `s${n}`, leaf: `l${n}` });

/** One pane, then split right, then split the right half downwards. */
function threePanes(): Node {
  let root: Node = leaf("l0", "a");
  root = splitPane(root, "a", "x", "b", ids(1));
  root = splitPane(root, "b", "y", "c", ids(2));
  return root;
}

describe("layout", () => {
  it("gives a lone pane the whole area", () => {
    expect(layout(leaf("l0", "a")).panes).toEqual([
      { paneId: "a", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });

  it("leaves no gap between siblings, at any depth", () => {
    const { panes } = layout(threePanes());
    const byId = Object.fromEntries(panes.map((pane) => [pane.paneId, pane.rect]));
    expect(byId.a.left + byId.a.width).toBeCloseTo(byId.b.left);
    expect(byId.b.top + byId.b.height).toBeCloseTo(byId.c.top);
    // Every pane's area sums back to the whole.
    const area = panes.reduce((sum, pane) => sum + pane.rect.width * pane.rect.height, 0);
    expect(area).toBeCloseTo(100 * 100);
  });

  it("emits one divider per split", () => {
    expect(layout(threePanes()).dividers).toHaveLength(2);
  });

  it("clamps a ratio dragged past the minimum", () => {
    const root = setRatio(threePanes(), "s1", 0.001);
    const [pane] = layout(root).panes;
    expect(pane.rect.width).toBeGreaterThan(0);
    expect(pane.rect.width).toBeCloseTo(8);
  });
});

describe("splitPane", () => {
  it("puts the new pane after the target by default", () => {
    expect(paneIds(splitPane(leaf("l0", "a"), "a", "x", "b", ids(1)))).toEqual(["a", "b"]);
  });

  it("puts it before when asked", () => {
    expect(paneIds(splitPane(leaf("l0", "a"), "a", "x", "b", ids(1), true))).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("splitPlacement", () => {
  it("reads a direction as an axis and a side", () => {
    expect(splitPlacement("right")).toEqual({ axis: "x", before: false });
    expect(splitPlacement("left")).toEqual({ axis: "x", before: true });
    expect(splitPlacement("down")).toEqual({ axis: "y", before: false });
    expect(splitPlacement("up")).toEqual({ axis: "y", before: true });
  });

  it("agrees with what splitPane does with them", () => {
    const { axis, before } = splitPlacement("up");
    expect(paneIds(splitPane(leaf("l0", "a"), "a", axis, "b", ids(1), before))).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("repointPane", () => {
  it("swaps the pane behind a leaf without touching the shape", () => {
    const before = layout(threePanes());
    const after = layout(repointPane(threePanes(), "b", "z"));
    expect(after.panes.map((pane) => pane.rect)).toEqual(before.panes.map((pane) => pane.rect));
    expect(after.panes.map((pane) => pane.paneId)).toEqual(["a", "z", "c"]);
  });

  it("leaves a tree that never held the pane alone", () => {
    const root = threePanes();
    expect(repointPane(root, "nobody", "z")).toBe(root);
  });
});

describe("substituteTree", () => {
  it("puts a whole tree where one pane was", () => {
    const incoming = splitPane(leaf("l8", "x"), "x", "y", "y", ids(8));
    const root = substituteTree(threePanes(), "b", incoming);
    expect(paneIds(root)).toEqual(["a", "x", "y", "c"]);
    // The arrangement that arrived is still the arrangement it had.
    expect(countPanes(root)).toBe(4);
    expect(layout(root).dividers).toHaveLength(3);
  });
});

describe("removePane", () => {
  it("collapses the split it leaves behind", () => {
    const root = removePane(threePanes(), "c");
    expect(root).not.toBeNull();
    expect(paneIds(root!)).toEqual(["a", "b"]);
    expect(layout(root!).dividers).toHaveLength(1);
  });

  it("returns null once the last pane goes", () => {
    expect(removePane(leaf("l0", "a"), "a")).toBeNull();
  });

  it("gives a surviving sibling the whole area", () => {
    const root = removePane(splitPane(leaf("l0", "a"), "a", "x", "b", ids(1)), "a")!;
    expect(layout(root).panes[0].rect).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });
});

describe("movePane", () => {
  it("swaps in place on a centre drop, keeping the shape", () => {
    const before = layout(threePanes());
    const after = layout(movePane(threePanes(), "a", "c", "center", ids(9)));
    expect(after.panes.map((pane) => pane.rect)).toEqual(
      before.panes.map((pane) => pane.rect),
    );
    expect(after.panes.map((pane) => pane.paneId)).toEqual(["c", "b", "a"]);
  });

  it("re-splits at the drop edge and collapses the old home", () => {
    const root = movePane(threePanes(), "c", "a", "top", ids(9));
    expect(paneIds(root)).toEqual(["c", "a", "b"]);
    // 'b' was 'c's sibling and should now own that whole column.
    const byId = Object.fromEntries(
      layout(root).panes.map((pane) => [pane.paneId, pane.rect]),
    );
    expect(byId.b.height).toBeCloseTo(100);
  });

  it("never loses or duplicates a pane", () => {
    const root = movePane(threePanes(), "a", "b", "bottom", ids(9));
    expect([...paneIds(root)].sort()).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when dropped on itself", () => {
    const root = threePanes();
    expect(movePane(root, "a", "a", "left", ids(9))).toBe(root);
  });
});

describe("neighbor", () => {
  const panes = layout(threePanes()).panes;

  it("finds the pane across a vertical seam", () => {
    expect(neighbor(panes, "a", "right")).toBe("b");
    expect(neighbor(panes, "b", "left")).toBe("a");
  });

  it("finds the pane across a horizontal seam", () => {
    expect(neighbor(panes, "b", "down")).toBe("c");
    expect(neighbor(panes, "c", "up")).toBe("b");
  });

  it("returns nothing at the edge of the window", () => {
    expect(neighbor(panes, "a", "left")).toBeNull();
    expect(neighbor(panes, "a", "up")).toBeNull();
  });

  it("ignores panes that only touch diagonally", () => {
    // 'a' spans the full height on the left; 'c' is the lower right. Moving up
    // from 'c' must reach 'b', never 'a'.
    expect(neighbor(panes, "c", "up")).toBe("b");
  });
});

describe("resizeTarget", () => {
  it("moves the ratio of the nearest split on the right axis", () => {
    const root = threePanes();
    expect(resizeTarget(root, "a", "right")).toEqual({ nodeId: "s1", delta: 1 });
    // 'b' is the second child of s1, so growing it leftwards lowers the ratio.
    expect(resizeTarget(root, "b", "left")).toEqual({ nodeId: "s1", delta: -1 });
  });

  it("prefers the innermost split when several share an axis", () => {
    expect(resizeTarget(threePanes(), "c", "up")).toEqual({ nodeId: "s2", delta: -1 });
  });

  it("declines when no split runs on that axis", () => {
    expect(resizeTarget(leaf("l0", "a"), "a", "left")).toBeNull();
  });

  it("declines when the pane is already against that edge", () => {
    // 'a' is the left-hand pane: there is no divider on its left to grow into.
    expect(resizeTarget(threePanes(), "a", "left")).toBeNull();
    expect(resizeTarget(threePanes(), "b", "up")).toBeNull();
  });

  it("skips an ancestor on the wrong axis to find a usable one", () => {
    // 'c' sits under a y-split, but growing it left has to reach past that to
    // the x-split above.
    expect(resizeTarget(threePanes(), "c", "left")).toEqual({ nodeId: "s1", delta: -1 });
  });
});

describe("graftTree", () => {
  /** The right-hand half of `threePanes`: 'b' above 'c'. */
  function stacked(): Node {
    return splitPane(leaf("g0", "b"), "b", "y", "c", ids(9));
  }

  it("puts a whole tree beside a pane, keeping its shape", () => {
    const root = graftTree(leaf("l0", "a"), "a", "x", stacked(), "graft");

    expect(paneIds(root)).toEqual(["a", "b", "c"]);
    // 'b' and 'c' arrive still stacked, not flattened into siblings of 'a'.
    const boxes = layout(root).panes;
    const rect = (paneId: string) => boxes.find((box) => box.paneId === paneId)!.rect;
    expect(rect("a")).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(rect("b")).toEqual({ left: 50, top: 0, width: 50, height: 50 });
    expect(rect("c")).toEqual({ left: 50, top: 50, width: 50, height: 50 });
  });

  it("puts it in front when asked", () => {
    const root = graftTree(leaf("l0", "a"), "a", "y", stacked(), "graft", true);
    expect(paneIds(root)).toEqual(["b", "c", "a"]);
    expect(layout(root).panes.find((box) => box.paneId === "a")!.rect).toEqual({
      left: 0,
      top: 50,
      width: 100,
      height: 50,
    });
  });

  it("grafts onto a pane nested deep in the target", () => {
    const root = graftTree(threePanes(), "c", "x", stacked(), "graft");
    expect(paneIds(root)).toEqual(["a", "b", "c", "b", "c"]);
    expect(countPanes(root)).toBe(5);
  });

  it("leaves the tree alone when the target pane is not in it", () => {
    const before = threePanes();
    expect(graftTree(before, "nobody", "x", stacked(), "graft")).toBe(before);
  });
});

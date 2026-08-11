import { describe, expect, it } from "vitest";

import {
  isControlTabId,
  panesFor,
  panesOf,
  toNode,
  windowTabId,
  type TmuxLayoutNode,
} from "./tmuxControl";
import { layout, paneIds } from "@/state/tree";
import type { Node } from "@/state/tree";

/** A pane the way `control.rs` serialises one. */
function pane(n: number, width: number, height: number): TmuxLayoutNode {
  return { kind: "pane", id: `tmux-w-${n}`, tmux: `%${n}`, width, height };
}

function split(
  axis: "x" | "y",
  width: number,
  height: number,
  children: TmuxLayoutNode[],
): TmuxLayoutNode {
  return { kind: "split", axis, width, height, children };
}

/** Where a pane ends up on screen, as `Workspace` would place it. */
function boxOf(root: Node, paneId: string) {
  const box = layout(root).panes.find((entry) => entry.paneId === paneId);
  if (!box) throw new Error(`${paneId} is not in the layout`);
  return box.rect;
}

describe("toNode", () => {
  it("turns a single-pane window into a single leaf", () => {
    const root = toNode(pane(0, 80, 24), "tab");
    expect(paneIds(root)).toEqual(["tmux-w-0"]);
    expect(boxOf(root, "tmux-w-0")).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  });

  it("puts a two-way split where tmux put it", () => {
    // tmux's own numbers for a `split-window -h` in an 80-column window: two
    // panes of 40 and 39, with a column of divider between them.
    const root = toNode(
      split("x", 80, 24, [pane(0, 40, 24), pane(1, 39, 24)]),
      "tab",
    );
    const left = boxOf(root, "tmux-w-0");
    const right = boxOf(root, "tmux-w-1");
    expect(left.left).toBe(0);
    expect(left.width).toBeCloseTo(50.6, 0);
    expect(right.left).toBeCloseTo(50.6, 0);
    expect(left.width + right.width).toBeCloseTo(100, 5);
  });

  it("folds three panes in a row into thirds, not into halves", () => {
    // The trap this is here for: a right-leaning fold whose ratios are shares
    // of the *whole* would put the first pane at 1/3 and then split the rest
    // down the middle, landing the second at 1/3 of the whole rather than of
    // what is left. Each ratio has to be against the remainder.
    const root = toNode(
      split("x", 90, 24, [pane(0, 30, 24), pane(1, 30, 24), pane(2, 30, 24)]),
      "tab",
    );
    const widths = ["tmux-w-0", "tmux-w-1", "tmux-w-2"].map((id) => boxOf(root, id).width);
    for (const width of widths) expect(width).toBeCloseTo(100 / 3, 4);
    expect(widths.reduce((a, b) => a + b)).toBeCloseTo(100, 5);
  });

  it("keeps uneven runs uneven in the right proportions", () => {
    const root = toNode(
      split("y", 80, 100, [pane(0, 80, 50), pane(1, 80, 30), pane(2, 80, 20)]),
      "tab",
    );
    expect(boxOf(root, "tmux-w-0").height).toBeCloseTo(50, 4);
    expect(boxOf(root, "tmux-w-1").height).toBeCloseTo(30, 4);
    expect(boxOf(root, "tmux-w-2").height).toBeCloseTo(20, 4);
  });

  it("stacks on y and lays side by side on x", () => {
    const across = toNode(split("x", 80, 24, [pane(0, 40, 24), pane(1, 39, 24)]), "t");
    const down = toNode(split("y", 80, 24, [pane(0, 80, 12), pane(1, 80, 11)]), "t");

    // Side by side: same top, different left.
    expect(boxOf(across, "tmux-w-0").top).toBe(boxOf(across, "tmux-w-1").top);
    expect(boxOf(across, "tmux-w-0").left).not.toBe(boxOf(across, "tmux-w-1").left);
    // Stacked: same left, different top.
    expect(boxOf(down, "tmux-w-0").left).toBe(boxOf(down, "tmux-w-1").left);
    expect(boxOf(down, "tmux-w-0").top).not.toBe(boxOf(down, "tmux-w-1").top);
  });

  it("handles a split nested inside a split", () => {
    const root = toNode(
      split("x", 80, 24, [
        pane(0, 40, 24),
        split("y", 39, 24, [pane(1, 39, 12), pane(2, 39, 11)]),
      ]),
      "tab",
    );
    expect(paneIds(root).sort()).toEqual(["tmux-w-0", "tmux-w-1", "tmux-w-2"]);
    // The left pane is full height; the right two share it.
    expect(boxOf(root, "tmux-w-0").height).toBe(100);
    expect(boxOf(root, "tmux-w-1").height).toBeLessThan(100);
    expect(boxOf(root, "tmux-w-2").height).toBeLessThan(100);
  });

  it("gives the same layout the same node ids twice over", () => {
    // The property the whole feature rests on: a refresh that describes the
    // same shape must produce the same tree, or `Workspace` would remount every
    // terminal on screen and kill the shells inside them.
    const shape = split("x", 80, 24, [pane(0, 40, 24), pane(1, 39, 24)]);
    expect(toNode(shape, "tab")).toEqual(toNode(shape, "tab"));
  });

  it("survives a split with a single child rather than producing a stray node", () => {
    const root = toNode(split("x", 80, 24, [pane(7, 80, 24)]), "tab");
    expect(paneIds(root)).toEqual(["tmux-w-7"]);
  });
});

describe("panesOf and panesFor", () => {
  it("finds every pane in tmux's order", () => {
    const shape = split("x", 80, 24, [
      pane(0, 40, 24),
      split("y", 39, 24, [pane(1, 39, 12), pane(2, 39, 11)]),
    ]);
    expect(panesOf(shape).map((entry) => entry.tmux)).toEqual(["%0", "%1", "%2"]);
  });

  it("marks a pane as control-mode with both fields, not one", () => {
    // `tmux` alone means tmux is running *inside* an ordinary pane, which is a
    // different integration and behaves differently in `TerminalPane`.
    const panes = panesFor("work", pane(3, 80, 24));
    const only = panes["tmux-w-3"];
    expect(only).toMatchObject({ kind: "terminal", tmux: "work", tmuxPane: "%3" });
  });
});

describe("tab ids", () => {
  it("derives one per tmux window, stable across refreshes", () => {
    expect(windowTabId("work", "@2")).toBe("tmuxwin-work-2");
    expect(windowTabId("work", "@2")).toBe(windowTabId("work", "@2"));
  });

  it("squeezes a session name into the same alphabet the Rust side uses", () => {
    // Kept in step with `pane_key` in control.rs; a mismatch would put a
    // window's tab and its panes in different namespaces.
    expect(windowTabId("my work: session", "@0")).toBe("tmuxwin-my-work--session-0");
  });

  it("recognises its own tab ids and nobody else's", () => {
    expect(isControlTabId(windowTabId("work", "@0"))).toBe(true);
    expect(isControlTabId("3f2a9c1b7d4e5f6a01")).toBe(false);
  });
});

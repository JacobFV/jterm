import { describe, expect, it } from "vitest";

import { countPanes, layout, paneIds } from "./tree";
import { type Workspace, emptyWorkspace, reduce } from "./workspace";

/**
 * Two tabs: the first a lone terminal, the second split into two.
 *
 * Returned alongside the ids the assertions need, because ids are minted and
 * so cannot be written down in the test.
 */
function twoTabs() {
  const start = emptyWorkspace();
  const targetTabId = start.tabs[0].id;
  const targetPaneId = start.tabs[0].focusedPaneId;

  let state: Workspace = reduce(start, { type: "tab/new", kind: "terminal" });
  const sourceTabId = state.tabs[1].id;
  state = reduce(state, {
    type: "pane/split",
    tabId: sourceTabId,
    paneId: state.tabs[1].focusedPaneId,
    axis: "y",
    kind: "terminal",
  });

  const source = state.tabs[1];
  return {
    state,
    targetTabId,
    targetPaneId,
    sourceTabId,
    sourceRoot: source.root,
    sourcePaneIds: paneIds(source.root),
    sourceFocusedPaneId: source.focusedPaneId,
  };
}

describe("tab/graft", () => {
  it("folds the whole tab into the target pane's slot", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "tab/graft",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
      edge: "right",
    });

    // The source tab is gone: this is a move, not a copy.
    expect(next.tabs).toHaveLength(1);
    const tab = next.tabs[0];
    expect(tab.id).toBe(setup.targetTabId);
    expect(next.activeTabId).toBe(setup.targetTabId);

    expect(countPanes(tab.root)).toBe(3);
    expect(Object.keys(tab.panes).sort()).toEqual(
      [setup.targetPaneId, ...setup.sourcePaneIds].sort(),
    );

    // The arrangement the user had already made survives the move: the two
    // panes arrive as a subtree, not as siblings of the pane they landed on.
    expect(tab.root).toMatchObject({
      kind: "split",
      axis: "x",
      children: [{ kind: "leaf", paneId: setup.targetPaneId }, setup.sourceRoot],
    });
  });

  it("lands on the side it was dropped", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "tab/graft",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
      edge: "top",
    });

    expect(next.tabs[0].root).toMatchObject({
      kind: "split",
      axis: "y",
      children: [setup.sourceRoot, { kind: "leaf", paneId: setup.targetPaneId }],
    });
  });

  it("moves focus to what was dragged", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "tab/graft",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
      edge: "right",
    });
    expect(next.tabs[0].focusedPaneId).toBe(setup.sourceFocusedPaneId);
  });

  it("unzooms, since a drop is a request to see both", () => {
    const setup = twoTabs();
    const zoomed = reduce(setup.state, { type: "pane/zoom", tabId: setup.sourceTabId });
    expect(zoomed.tabs[1].zoomedPaneId).not.toBeNull();

    const next = reduce(zoomed, {
      type: "tab/graft",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
      edge: "right",
    });
    expect(next.tabs[0].zoomedPaneId).toBeNull();
  });

  it("refuses to put a tab inside itself", () => {
    const setup = twoTabs();
    const sourcePaneId = setup.sourcePaneIds[0];
    const next = reduce(setup.state, {
      type: "tab/graft",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.sourceTabId,
      targetPaneId: sourcePaneId,
      edge: "right",
    });
    expect(next).toBe(setup.state);
  });

  it("ignores a target pane that is not in the target tab", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "tab/graft",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      // A pane of the *source* tab: not somewhere the source can land.
      targetPaneId: setup.sourcePaneIds[0],
      edge: "right",
    });
    expect(next).toBe(setup.state);
  });
});

describe("tab/absorb", () => {
  it("trades the pane for the tab, keeping both alive", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "tab/absorb",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
    });

    // Two tabs before, two tabs after: this is an exchange, not a merge.
    expect(next.tabs).toHaveLength(2);
    expect(next.activeTabId).toBe(setup.targetTabId);

    const target = next.tabs.find((tab) => tab.id === setup.targetTabId)!;
    expect(paneIds(target.root)).toEqual(setup.sourcePaneIds);
    // The pane that was there has gone with it, rather than lingering in the
    // map behind a tree that no longer mentions it.
    expect(Object.keys(target.panes).sort()).toEqual([...setup.sourcePaneIds].sort());
    expect(target.focusedPaneId).toBe(setup.sourceFocusedPaneId);

    // …and reappears as a tab of its own, standing where the source tab stood.
    const evicted = next.tabs[1];
    expect(evicted.id).not.toBe(setup.sourceTabId);
    expect(paneIds(evicted.root)).toEqual([setup.targetPaneId]);
    expect(evicted.focusedPaneId).toBe(setup.targetPaneId);
  });

  it("drops the tab into the pane's slot, leaving the rest of the split alone", () => {
    const setup = twoTabs();
    // Give the target tab a second pane, so there is a shape to disturb.
    const split = reduce(setup.state, {
      type: "pane/split",
      tabId: setup.targetTabId,
      paneId: setup.targetPaneId,
      axis: "x",
      kind: "terminal",
    });
    const sibling = paneIds(split.tabs[0].root).find((id) => id !== setup.targetPaneId)!;

    const next = reduce(split, {
      type: "tab/absorb",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
    });
    const target = next.tabs.find((tab) => tab.id === setup.targetTabId)!;
    expect(paneIds(target.root)).toEqual([...setup.sourcePaneIds, sibling]);
    // The two panes that arrived share the half the replaced pane had.
    const rects = Object.fromEntries(
      layout(target.root).panes.map((pane) => [pane.paneId, pane.rect]),
    );
    expect(rects[sibling].width).toBeCloseTo(50);
    expect(rects[setup.sourcePaneIds[0]].width).toBeCloseTo(50);
  });

  it("refuses to move a tab into one of its own panes", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "tab/absorb",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.sourceTabId,
      targetPaneId: setup.sourcePaneIds[0],
    });
    expect(next).toBe(setup.state);
  });
});

describe("pane/replace", () => {
  it("puts a different kind of pane in the same slot", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "pane/replace",
      tabId: setup.sourceTabId,
      paneId: setup.sourcePaneIds[0],
      kind: "browser",
    });
    const tab = next.tabs.find((candidate) => candidate.id === setup.sourceTabId)!;

    expect(countPanes(tab.root)).toBe(2);
    const [first, second] = paneIds(tab.root);
    // A fresh id, because a pane's id is how its pty and its scrollback file
    // are found and the new pane owns neither.
    expect(first).not.toBe(setup.sourcePaneIds[0]);
    expect(second).toBe(setup.sourcePaneIds[1]);
    expect(tab.panes[first].kind).toBe("browser");
    expect(setup.sourcePaneIds[0] in tab.panes).toBe(false);
  });

  it("carries focus and zoom across to the replacement", () => {
    const setup = twoTabs();
    const focused = setup.sourceFocusedPaneId;
    const zoomed = reduce(setup.state, {
      type: "pane/zoom",
      tabId: setup.sourceTabId,
      paneId: focused,
    });

    const next = reduce(zoomed, {
      type: "pane/replace",
      tabId: setup.sourceTabId,
      paneId: focused,
      kind: "notepad",
    });
    const tab = next.tabs.find((candidate) => candidate.id === setup.sourceTabId)!;
    const replacement = paneIds(tab.root).find((id) => !setup.sourcePaneIds.includes(id))!;
    expect(tab.focusedPaneId).toBe(replacement);
    expect(tab.zoomedPaneId).toBe(replacement);
  });

  it("ignores a pane that is not in the tab", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "pane/replace",
      tabId: setup.targetTabId,
      paneId: setup.sourcePaneIds[0],
      kind: "browser",
    });
    expect(next).toBe(setup.state);
  });
});

describe("pane/split", () => {
  it("seeds the new pane, and puts it on the side asked for", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "pane/split",
      tabId: setup.targetTabId,
      paneId: setup.targetPaneId,
      axis: "y",
      before: true,
      kind: "notepad",
      seed: { path: "/tmp/notes.md" },
    });
    const tab = next.tabs[0];
    const [first, second] = paneIds(tab.root);
    expect(second).toBe(setup.targetPaneId);
    expect(tab.panes[first]).toMatchObject({ kind: "notepad", path: "/tmp/notes.md" });
    expect(tab.focusedPaneId).toBe(first);
  });
});

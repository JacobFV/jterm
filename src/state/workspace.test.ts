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

/* ── Control mode ────────────────────────────────────────────────────────── */

import type { TmuxWindow } from "@/lib/tmuxControl";
import { windowTabId } from "@/lib/tmuxControl";

function tmuxPane(n: number, width = 80, height = 24) {
  return { kind: "pane" as const, id: `tmux-work-${n}`, tmux: `%${n}`, width, height };
}

function window(id: string, layout: TmuxWindow["layout"], name = "bash"): TmuxWindow {
  return { id, name, active: true, layout };
}

/** The state after tmux has described a session with the given windows. */
function synced(windows: TmuxWindow[], from: Workspace = emptyWorkspace()): Workspace {
  return reduce(from, { type: "tmux/sync", session: "work", windows });
}

describe("tmux/sync", () => {
  it("adds a tab per tmux window, alongside the ordinary ones", () => {
    const start = emptyWorkspace();
    const state = synced([window("@0", tmuxPane(0)), window("@1", tmuxPane(1))], start);

    expect(state.tabs).toHaveLength(3);
    // The tab that was already open is untouched: one session's news says
    // nothing about anything else in the window.
    expect(state.tabs[0].id).toBe(start.tabs[0].id);
    expect(state.tabs.map((tab) => tab.id).slice(1)).toEqual([
      windowTabId("work", "@0"),
      windowTabId("work", "@1"),
    ]);
  });

  it("names the panes so they can be written to, and marks them control-mode", () => {
    const state = synced([window("@0", tmuxPane(3))]);
    const tab = state.tabs.find((entry) => entry.id === windowTabId("work", "@0"))!;
    expect(tab.panes["tmux-work-3"]).toMatchObject({
      kind: "terminal",
      tmux: "work",
      tmuxPane: "%3",
    });
    expect(tab.focusedPaneId).toBe("tmux-work-3");
  });

  it("keeps a tab's identity when tmux only changes its shape", () => {
    // The property that keeps live terminals alive: a split arriving from tmux
    // must not make a new tab or new panes for the panes that already existed,
    // because `Workspace` renders from ids and would unmount everything else.
    const one = synced([window("@0", tmuxPane(0))]);
    const before = one.tabs.find((tab) => tab.id === windowTabId("work", "@0"))!;

    const two = synced(
      [
        window("@0", {
          kind: "split",
          axis: "x",
          width: 80,
          height: 24,
          children: [tmuxPane(0, 40), tmuxPane(1, 39)],
        }),
      ],
      one,
    );
    const after = two.tabs.find((tab) => tab.id === windowTabId("work", "@0"))!;

    expect(after.id).toBe(before.id);
    expect(after.panes["tmux-work-0"]).toBeDefined();
    expect(countPanes(after.root)).toBe(2);
    expect(paneIds(after.root).sort()).toEqual(["tmux-work-0", "tmux-work-1"]);
  });

  it("keeps the focused pane if tmux still has it", () => {
    const one = synced([
      window("@0", {
        kind: "split",
        axis: "x",
        width: 80,
        height: 24,
        children: [tmuxPane(0, 40), tmuxPane(1, 39)],
      }),
    ]);
    const tabId = windowTabId("work", "@0");
    const focused = reduce(one, { type: "pane/focus", tabId, paneId: "tmux-work-1" });
    expect(focused.tabs.find((tab) => tab.id === tabId)!.focusedPaneId).toBe("tmux-work-1");

    // A resize elsewhere should not move the caret out of the pane it is in.
    const again = synced(
      [
        window("@0", {
          kind: "split",
          axis: "x",
          width: 80,
          height: 24,
          children: [tmuxPane(0, 20), tmuxPane(1, 59)],
        }),
      ],
      focused,
    );
    expect(again.tabs.find((tab) => tab.id === tabId)!.focusedPaneId).toBe("tmux-work-1");
  });

  it("falls back to a pane that exists when the focused one is killed", () => {
    const two = synced([
      window("@0", {
        kind: "split",
        axis: "x",
        width: 80,
        height: 24,
        children: [tmuxPane(0, 40), tmuxPane(1, 39)],
      }),
    ]);
    const tabId = windowTabId("work", "@0");
    const focused = reduce(two, { type: "pane/focus", tabId, paneId: "tmux-work-1" });

    const one = synced([window("@0", tmuxPane(0))], focused);
    expect(one.tabs.find((tab) => tab.id === tabId)!.focusedPaneId).toBe("tmux-work-0");
  });

  it("drops the tab of a window tmux no longer has", () => {
    const two = synced([window("@0", tmuxPane(0)), window("@1", tmuxPane(1))]);
    const one = synced([window("@0", tmuxPane(0))], two);

    expect(one.tabs.some((tab) => tab.id === windowTabId("work", "@1"))).toBe(false);
    expect(one.tabs.some((tab) => tab.id === windowTabId("work", "@0"))).toBe(true);
  });

  it("leaves another session's tabs alone", () => {
    const mine = synced([window("@0", tmuxPane(0))]);
    const theirs = reduce(mine, {
      type: "tmux/sync",
      session: "other",
      windows: [
        {
          id: "@0",
          name: "bash",
          active: true,
          layout: { kind: "pane", id: "tmux-other-0", tmux: "%0", width: 80, height: 24 },
        },
      ],
    });
    expect(theirs.tabs.some((tab) => tab.id === windowTabId("work", "@0"))).toBe(true);
    expect(theirs.tabs.some((tab) => tab.id === windowTabId("other", "@0"))).toBe(true);
  });

  it("takes the window's name for the tab", () => {
    const state = synced([window("@0", tmuxPane(0), "vim")]);
    expect(state.tabs.find((tab) => tab.id === windowTabId("work", "@0"))!.title).toBe("vim");
  });

  it("never leaves the active tab pointing at something that is gone", () => {
    const two = synced([window("@0", tmuxPane(0)), window("@1", tmuxPane(1))]);
    const active = reduce(two, { type: "tab/select", tabId: windowTabId("work", "@1") });
    const one = synced([window("@0", tmuxPane(0))], active);

    expect(one.tabs.some((tab) => tab.id === one.activeTabId)).toBe(true);
  });
});

describe("tmux/closed", () => {
  it("takes the session's tabs and leaves everything else", () => {
    const start = emptyWorkspace();
    const state = synced([window("@0", tmuxPane(0)), window("@1", tmuxPane(1))], start);
    const closed = reduce(state, { type: "tmux/closed", session: "work" });

    expect(closed.tabs).toHaveLength(1);
    expect(closed.tabs[0].id).toBe(start.tabs[0].id);
    expect(closed.activeTabId).toBe(start.tabs[0].id);
  });

  it("does nothing for a session that has no tabs here", () => {
    const state = synced([window("@0", tmuxPane(0))]);
    expect(reduce(state, { type: "tmux/closed", session: "elsewhere" })).toBe(state);
  });
});

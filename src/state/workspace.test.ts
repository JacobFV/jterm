import { describe, expect, it } from "vitest";

import { countPanes, layout, paneIds } from "./tree";
import { type Workspace, emptyWorkspace, reduce, themeOf } from "./workspace";

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

describe("themes at three levels", () => {
  it("resolves the innermost choice that was actually made", () => {
    const state = emptyWorkspace();
    const tab = state.tabs[0];
    const pane = tab.panes[tab.focusedPaneId];

    expect(themeOf("dark", tab, pane)).toBe("dark");
    expect(themeOf("dark", { ...tab, theme: "nord" }, pane)).toBe("nord");
    expect(themeOf("dark", { ...tab, theme: "nord" }, { ...pane, theme: "gruvbox" })).toBe(
      "gruvbox",
    );
    // A pane with a theme still answers for itself in a tab without one.
    expect(themeOf("dark", tab, { ...pane, theme: "gruvbox" })).toBe("gruvbox");
  });

  it("dresses a tab, and puts it back", () => {
    const start = emptyWorkspace();
    const tabId = start.tabs[0].id;
    const dressed = reduce(start, { type: "tab/theme", tabId, theme: "nord" });
    expect(dressed.tabs[0].theme).toBe("nord");
    const bare = reduce(dressed, { type: "tab/theme", tabId, theme: undefined });
    expect(bare.tabs[0].theme).toBeUndefined();
  });

  it("dresses one pane of a split without touching its sibling", () => {
    const setup = twoTabs();
    const tab = setup.state.tabs[1];
    const [first, second] = paneIds(tab.root);
    const next = reduce(setup.state, {
      type: "pane/theme",
      paneId: first,
      theme: "gruvbox",
    });
    expect(next.tabs[1].panes[first].theme).toBe("gruvbox");
    expect(next.tabs[1].panes[second].theme).toBeUndefined();
  });

  it("leaves the state alone when nothing would change", () => {
    const start = emptyWorkspace();
    const tabId = start.tabs[0].id;
    // Every hover in the theme menu dispatches, so the no-op case is the common
    // one: re-rendering the whole workspace for it would be a repaint per row.
    expect(reduce(start, { type: "tab/theme", tabId, theme: undefined })).toBe(start);
    const dressed = reduce(start, { type: "tab/theme", tabId, theme: "nord" });
    expect(reduce(dressed, { type: "tab/theme", tabId, theme: "nord" })).toBe(dressed);
  });

  it("leaves a split default, which is to say wearing its tab's theme", () => {
    const setup = twoTabs();
    const dressed = reduce(setup.state, {
      type: "tab/theme",
      tabId: setup.targetTabId,
      theme: "nord",
    });
    const next = reduce(dressed, {
      type: "pane/split",
      tabId: setup.targetTabId,
      paneId: setup.targetPaneId,
      axis: "x",
      kind: "terminal",
    });
    const tab = next.tabs[0];
    const fresh = tab.panes[tab.focusedPaneId];
    // Nothing was copied onto the pane...
    expect(fresh.theme).toBeUndefined();
    // ...and it is wearing the tab's theme all the same, which is the point:
    // default is a reference, not the absence of a colour.
    expect(themeOf("dark", tab, fresh)).toBe("nord");
    // So it follows the tab rather than being frozen at what the tab was.
    const recoloured = reduce(next, {
      type: "tab/theme",
      tabId: setup.targetTabId,
      theme: "gruvbox",
    });
    expect(themeOf("dark", recoloured.tabs[0], fresh)).toBe("gruvbox");
  });

  it("does not carry an override onto the pane split off a dressed one", () => {
    // The override exists to tell this pane from the one beside it; duplicating
    // it would undo the distinction as the split is drawn.
    const setup = twoTabs();
    const dressed = reduce(setup.state, {
      type: "pane/theme",
      paneId: setup.targetPaneId,
      theme: "gruvbox",
    });
    const next = reduce(dressed, {
      type: "pane/split",
      tabId: setup.targetTabId,
      paneId: setup.targetPaneId,
      axis: "x",
      kind: "terminal",
    });
    expect(next.tabs[0].panes[next.tabs[0].focusedPaneId].theme).toBeUndefined();
  });

  it("gives a brand-new tab no theme of its own, however it was made", () => {
    // Including the one `tab/absorb` mints for the pane it displaces. Copying
    // the theme there would look right for a moment and then stop following the
    // app, which is the one thing a default must never do.
    const setup = twoTabs();
    const dressed = reduce(setup.state, {
      type: "tab/theme",
      tabId: setup.targetTabId,
      theme: "nord",
    });
    const next = reduce(dressed, {
      type: "tab/absorb",
      sourceTabId: setup.sourceTabId,
      targetTabId: setup.targetTabId,
      targetPaneId: setup.targetPaneId,
    });
    const evicted = next.tabs.find((tab) => tab.panes[setup.targetPaneId]);
    expect(evicted?.theme).toBeUndefined();
    expect(themeOf("dark", evicted)).toBe("dark");

    expect(reduce(setup.state, { type: "tab/new", kind: "terminal" }).tabs.at(-1)?.theme)
      .toBeUndefined();
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

/* ── Pop-ups and moving panes ────────────────────────────────────────────── */

describe("pop-ups", () => {
  it("floats a new pane over every tab, focused, without touching the tabs", () => {
    const start = emptyWorkspace();
    const next = reduce(start, { type: "popup/open", kind: "terminal" });

    expect(next.popups).toHaveLength(1);
    expect(next.focusedPopupId).toBe(next.popups[0].pane.id);
    expect(next.tabs).toEqual(start.tabs);
    // Lower right, which is where a thing that must not be in the way goes.
    expect(next.popups[0].x + next.popups[0].width).toBeLessThanOrEqual(1);
    expect(next.popups[0].x).toBeGreaterThan(0.5);
  });

  it("deals a second pop-up clear of the first", () => {
    let state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    state = reduce(state, { type: "popup/open", kind: "notepad" });
    expect(state.popups[1].x).toBeLessThan(state.popups[0].x);
  });

  it("keeps a pop-up on the rail however far it is dragged", () => {
    let state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    const paneId = state.popups[0].pane.id;

    state = reduce(state, { type: "popup/move", paneId, x: 4 });
    expect(state.popups[0].x).toBeCloseTo(1 - state.popups[0].width);

    state = reduce(state, { type: "popup/move", paneId, x: -3 });
    expect(state.popups[0].x).toBe(0);
  });

  it("hands the keyboard back to the tab when a pop-up is minimised", () => {
    let state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    const paneId = state.popups[0].pane.id;
    expect(state.focusedPopupId).toBe(paneId);

    state = reduce(state, { type: "popup/state", paneId, state: "minimized" });
    expect(state.focusedPopupId).toBeNull();

    // Opening it again is picking it back up.
    state = reduce(state, { type: "popup/state", paneId, state: "open" });
    expect(state.focusedPopupId).toBe(paneId);
  });

  it("raises a focused pop-up to the front of the stack", () => {
    let state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    const first = state.popups[0].pane.id;
    state = reduce(state, { type: "popup/open", kind: "notepad" });

    state = reduce(state, { type: "popup/focus", paneId: first });
    expect(state.popups[state.popups.length - 1].pane.id).toBe(first);
    expect(state.focusedPopupId).toBe(first);
  });

  it("gives the keyboard back to a tab as soon as one is chosen", () => {
    let state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    expect(state.focusedPopupId).not.toBeNull();

    state = reduce(state, { type: "tab/select", tabId: state.tabs[0].id });
    expect(state.focusedPopupId).toBeNull();
  });
});

describe("pane/moveTo", () => {
  it("moves a pane out of a split and onto the rail, keeping its id", () => {
    const setup = twoTabs();
    const [first, second] = setup.sourcePaneIds;

    const next = reduce(setup.state, { type: "pane/moveTo", paneId: first, to: { kind: "popup" } });

    expect(next.popups.map((popup) => popup.pane.id)).toEqual([first]);
    expect(Object.keys(next.tabs[1].panes)).toEqual([second]);
    expect(countPanes(next.tabs[1].root)).toBe(1);
    // The id is the whole point: everything the pane owns outside React — its
    // pty, its scrollback, its draft — is found by it.
    expect(next.popups[0].pane).toBe(setup.state.tabs[1].panes[first]);
  });

  it("takes the tab with it when the pane was the only one in it", () => {
    const setup = twoTabs();
    const next = reduce(setup.state, {
      type: "pane/moveTo",
      paneId: setup.targetPaneId,
      to: { kind: "popup" },
    });

    expect(next.tabs.map((tab) => tab.id)).toEqual([setup.sourceTabId]);
    expect(next.popups[0].pane.id).toBe(setup.targetPaneId);
  });

  it("moves a pop-up back into a tab, beside the pane that was named", () => {
    const setup = twoTabs();
    const [first] = setup.sourcePaneIds;
    let state = reduce(setup.state, { type: "pane/moveTo", paneId: first, to: { kind: "popup" } });

    state = reduce(state, {
      type: "pane/moveTo",
      paneId: first,
      to: { kind: "split", paneId: setup.targetPaneId },
    });

    expect(state.popups).toHaveLength(0);
    const target = state.tabs.find((tab) => tab.id === setup.targetTabId)!;
    expect(paneIds(target.root)).toContain(first);
    expect(target.focusedPaneId).toBe(first);
    expect(state.activeTabId).toBe(setup.targetTabId);
    expect(state.focusedPopupId).toBeNull();
  });

  it("moves a pane into another tab", () => {
    const setup = twoTabs();
    const [first] = setup.sourcePaneIds;

    const next = reduce(setup.state, {
      type: "pane/moveTo",
      paneId: first,
      to: { kind: "tab", tabId: setup.targetTabId },
    });

    const target = next.tabs.find((tab) => tab.id === setup.targetTabId)!;
    expect(paneIds(target.root).sort()).toEqual([setup.targetPaneId, first].sort());
    expect(next.tabs.find((tab) => tab.id === setup.sourceTabId)!.panes[first]).toBeUndefined();
  });

  it("gives a pane a tab of its own", () => {
    const setup = twoTabs();
    const [first] = setup.sourcePaneIds;

    const next = reduce(setup.state, { type: "pane/moveTo", paneId: first, to: { kind: "newTab" } });

    expect(next.tabs).toHaveLength(3);
    const made = next.tabs[next.tabs.length - 1];
    expect(paneIds(made.root)).toEqual([first]);
    expect(next.activeTabId).toBe(made.id);
  });

  it("changes nothing when the destination cannot take the pane", () => {
    const setup = twoTabs();
    const [first] = setup.sourcePaneIds;

    // A pane cannot be split against itself, and the refusal must not cost the
    // pane: it was taken out of its tab before the destination was asked.
    const next = reduce(setup.state, {
      type: "pane/moveTo",
      paneId: first,
      to: { kind: "split", paneId: first },
    });
    expect(next).toBe(setup.state);

    const gone = reduce(setup.state, {
      type: "pane/moveTo",
      paneId: first,
      to: { kind: "tab", tabId: "a-tab-that-closed" },
    });
    expect(gone).toBe(setup.state);
  });

  it("ejects a pane without disposing of it, for a window that is adopting it", () => {
    const setup = twoTabs();
    const [first] = setup.sourcePaneIds;
    const pane = setup.state.tabs[1].panes[first];

    const sent = reduce(setup.state, { type: "pane/eject", paneId: first });
    expect(sent.tabs[1].panes[first]).toBeUndefined();

    const received = reduce(emptyWorkspace(), { type: "pane/adopt", pane, as: "popup" });
    expect(received.popups[0].pane.id).toBe(first);
  });
});

import { describe, expect, it } from "vitest";

import { decode, encode } from "./snapshot";
import { type Workspace, emptyWorkspace, reduce } from "./workspace";
import { windowTabId } from "@/lib/tmuxControl";

/** A workspace with one ordinary tab and one control-mode tab from `work`. */
function withControlTab(): Workspace {
  return reduce(emptyWorkspace(), {
    type: "tmux/sync",
    session: "work",
    windows: [
      {
        id: "@0",
        name: "bash",
        active: true,
        layout: { kind: "pane", id: "tmux-work-0", tmux: "%0", width: 80, height: 24 },
      },
    ],
  });
}

describe("control-mode tabs in the snapshot", () => {
  it("keeps the session name instead of the tab", () => {
    // tmux is still running and still knows which windows the session has, so
    // saving a copy of that shape could only be right by luck. The name is
    // enough to ask again.
    const restored = decode(encode(withControlTab(), {}))!;
    expect(restored.controlSessions).toEqual(["work"]);
    expect(restored.workspace.tabs.some((tab) => tab.id === windowTabId("work", "@0"))).toBe(
      false,
    );
  });

  it("leaves the ordinary tabs exactly as they were", () => {
    const before = withControlTab();
    const ordinary = before.tabs[0];
    const restored = decode(encode(before, {}))!;

    expect(restored.workspace.tabs).toHaveLength(1);
    expect(restored.workspace.tabs[0].id).toBe(ordinary.id);
  });

  it("does not leave the active tab pointing at a stripped one", () => {
    const before = withControlTab();
    const active = reduce(before, { type: "tab/select", tabId: windowTabId("work", "@0") });
    expect(active.activeTabId).toBe(windowTabId("work", "@0"));

    const restored = decode(encode(active, {}))!;
    expect(restored.workspace.tabs.some((tab) => tab.id === restored.workspace.activeTabId)).toBe(
      true,
    );
  });

  it("records nothing when no control session is attached", () => {
    expect(decode(encode(emptyWorkspace(), {}))!.controlSessions).toEqual([]);
  });

  it("treats a file from before this feature as having no sessions", () => {
    const json = encode(emptyWorkspace(), {});
    const older = JSON.parse(json);
    delete older.controlSessions;
    expect(decode(JSON.stringify(older))!.controlSessions).toEqual([]);
  });

  it("refuses junk in place of the session list", () => {
    // The snapshot is read after a crash, from a user-writable directory, and
    // every name in it is about to be handed to tmux as an argument.
    const json = JSON.parse(encode(emptyWorkspace(), {}));
    json.controlSessions = ["ok", 42, null, "", { name: "no" }];
    expect(decode(JSON.stringify(json))!.controlSessions).toEqual(["ok"]);

    json.controlSessions = "not an array";
    expect(decode(JSON.stringify(json))!.controlSessions).toEqual([]);
  });

  it("caps a session name at a length tmux could plausibly have", () => {
    const json = JSON.parse(encode(emptyWorkspace(), {}));
    json.controlSessions = ["x".repeat(5000)];
    expect(decode(JSON.stringify(json))!.controlSessions[0]).toHaveLength(128);
  });
});

describe("themes in the snapshot", () => {
  /** One tab wearing a theme, with one of its panes wearing another. */
  function dressed(): Workspace {
    const start = emptyWorkspace();
    const tabId = start.tabs[0].id;
    const paneId = start.tabs[0].focusedPaneId;
    return reduce(reduce(start, { type: "tab/theme", tabId, theme: "nord" }), {
      type: "pane/theme",
      paneId,
      theme: "gruvbox",
    });
  }

  it("brings both levels back", () => {
    const before = dressed();
    const tab = decode(encode(before, {}))!.workspace.tabs[0];
    expect(tab.theme).toBe("nord");
    expect(tab.panes[tab.focusedPaneId].theme).toBe("gruvbox");
  });

  it("costs the theme rather than the tab when the theme has gone", () => {
    // A file written by a build that had a theme this one does not — or one
    // that was hand-edited. The tab is still perfectly usable without it.
    const json = JSON.parse(encode(dressed(), {}));
    const tab = json.workspace.tabs[0];
    tab.theme = "chartreuse";
    tab.panes[tab.focusedPaneId].theme = { not: "a theme" };

    const restored = decode(JSON.stringify(json))!.workspace.tabs[0];
    expect(restored.theme).toBeUndefined();
    expect(restored.panes[restored.focusedPaneId].theme).toBeUndefined();
    expect(restored.id).toBe(tab.id);
  });

  it("leaves a file from before this feature undressed", () => {
    const tab = decode(encode(emptyWorkspace(), {}))!.workspace.tabs[0];
    expect(tab.theme).toBeUndefined();
    expect(tab.panes[tab.focusedPaneId].theme).toBeUndefined();
  });
});

describe("pop-ups in the snapshot", () => {
  it("brings the rail back as it was", () => {
    let state = reduce(emptyWorkspace(), { type: "popup/open", kind: "notepad" });
    const paneId = state.popups[0].pane.id;
    state = reduce(state, { type: "popup/move", paneId, x: 0.2 });
    state = reduce(state, { type: "popup/state", paneId, state: "minimized" });

    const restored = decode(encode(state, {}))!.workspace;
    expect(restored.popups).toHaveLength(1);
    expect(restored.popups[0].pane.id).toBe(paneId);
    expect(restored.popups[0].x).toBeCloseTo(0.2);
    expect(restored.popups[0].state).toBe("minimized");
  });

  it("keeps a pop-up's notepad text, which lives nowhere else", () => {
    const state = reduce(emptyWorkspace(), { type: "popup/open", kind: "notepad" });
    const paneId = state.popups[0].pane.id;

    const restored = decode(encode(state, { [paneId]: { text: "half a thought" } }))!;
    expect(restored.content[paneId]?.text).toBe("half a thought");
  });

  it("drops a pop-up that decodes to nothing usable, and keeps the rest", () => {
    const state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    const parsed = JSON.parse(encode(state, {}));
    parsed.workspace.popups = [
      { x: 0.1, width: 0.3, height: 0.3, state: "open" },
      { pane: { id: "no-such-kind", kind: "wormhole" }, x: 0.1 },
      ...parsed.workspace.popups,
    ];

    const restored = decode(JSON.stringify(parsed))!.workspace;
    expect(restored.popups).toHaveLength(1);
    expect(restored.popups[0].pane.kind).toBe("terminal");
  });

  it("clamps geometry a hand-edited file could put out of reach", () => {
    const state = reduce(emptyWorkspace(), { type: "popup/open", kind: "terminal" });
    const parsed = JSON.parse(encode(state, {}));
    parsed.workspace.popups[0] = { ...parsed.workspace.popups[0], x: 9, width: 0, height: 40 };

    const popup = decode(JSON.stringify(parsed))!.workspace.popups[0];
    expect(popup.width).toBeGreaterThan(0);
    expect(popup.height).toBeLessThanOrEqual(1);
    expect(popup.x + popup.width).toBeLessThanOrEqual(1);
  });
});

describe("what a pane was running", () => {
  it("comes back, so the icon and the offer to resume survive a restart", () => {
    const start = emptyWorkspace();
    const paneId = start.tabs[0].focusedPaneId;
    const state = reduce(reduce(start, {
      type: "pane/meta",
      paneId,
      patch: { command: "claude --dangerously-skip-permissions" },
    }), { type: "pane/profile", paneId, profile: "claude" });

    const restored = decode(encode(state, {}))!.workspace;
    const pane = restored.tabs[0].panes[paneId];
    expect(pane.kind === "terminal" && pane.command).toBe(
      "claude --dangerously-skip-permissions",
    );
    expect(pane.profile).toBe("claude");
  });

  it("drops a profile id this build no longer has, and keeps the pane", () => {
    // The same treatment a theme that went away gets: the icon falls back to
    // being worked out, rather than the pane being thrown away.
    const state = emptyWorkspace();
    const parsed = JSON.parse(encode(state, {}));
    const paneId = state.tabs[0].focusedPaneId;
    parsed.workspace.tabs[0].panes[paneId].profile = 42;

    const restored = decode(JSON.stringify(parsed))!.workspace;
    expect(restored.tabs[0].panes[paneId].profile).toBeUndefined();
  });
});

describe("a pane's own font size", () => {
  it("comes back after a restart", () => {
    const start = emptyWorkspace();
    const paneId = start.tabs[0].focusedPaneId;
    const state = reduce(start, { type: "pane/fontSize", paneId, fontSize: 18 });
    expect(decode(encode(state, {}))!.workspace.tabs[0].panes[paneId].fontSize).toBe(18);
  });

  it("is forgotten, not the pane, when the file holds nonsense", () => {
    const state = emptyWorkspace();
    const paneId = state.tabs[0].focusedPaneId;
    for (const junk of [9000, -1, "18", null]) {
      const parsed = JSON.parse(encode(state, {}));
      parsed.workspace.tabs[0].panes[paneId].fontSize = junk;
      const pane = decode(JSON.stringify(parsed))!.workspace.tabs[0].panes[paneId];
      expect(pane).toBeDefined();
      expect(pane.fontSize).toBeUndefined();
    }
  });
});

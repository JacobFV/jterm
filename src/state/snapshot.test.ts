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
      tabId,
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

import { describe, expect, it } from "vitest";

import { layout as place, paneIds } from "@/state/tree";
import type { PeerLayout } from "./ipc";
import { isPeerTab, mirrorTabs, peerTabPrefix } from "./peer";
import { controlPaneId } from "./tmuxControl";

/** A peer snapshot in the shape jterm writes one: two tabs, one of them split
 *  three ways, plus a notepad that has nothing to mirror. */
function peerSnapshot(): string {
  const terminal = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "terminal",
    tmux: `jterm-${id.slice(0, 8)}`,
    ...extra,
  });
  return JSON.stringify({
    version: 1,
    workspace: {
      tabs: [
        {
          id: "tabaaaaaaaaaaaaaaa",
          title: "CommandAGI",
          root: {
            kind: "split",
            id: "s1",
            axis: "x",
            ratio: 0.6,
            children: [
              {
                kind: "split",
                id: "s2",
                axis: "y",
                ratio: 0.5,
                children: [
                  { kind: "leaf", id: "l1", paneId: "aaaa1111aaaa1111aa" },
                  { kind: "leaf", id: "l2", paneId: "bbbb2222bbbb2222bb" },
                ],
              },
              { kind: "leaf", id: "l3", paneId: "notes0000notes0000" },
            ],
          },
          panes: {
            aaaa1111aaaa1111aa: terminal("aaaa1111aaaa1111aa", { cwd: "/repo", command: "claude" }),
            bbbb2222bbbb2222bb: terminal("bbbb2222bbbb2222bb", { name: "server" }),
            notes0000notes0000: { id: "notes0000notes0000", kind: "notepad" },
          },
          focusedPaneId: "bbbb2222bbbb2222bb",
          zoomedPaneId: null,
        },
        {
          id: "tabbbbbbbbbbbbbbbb",
          root: { kind: "leaf", id: "l4", paneId: "cccc3333cccc3333cc" },
          panes: { cccc3333cccc3333cc: terminal("cccc3333cccc3333cc") },
          focusedPaneId: "cccc3333cccc3333cc",
          zoomedPaneId: null,
        },
      ],
      activeTabId: "tabbbbbbbbbbbbbbbb",
      popups: [],
      focusedPopupId: null,
    },
    content: {},
    controlSessions: [],
  });
}

const PANES: PeerLayout["panes"] = [
  { session: "jterm-aaaa1111", pane: "%3" },
  { session: "jterm-bbbb2222", pane: "%5" },
  { session: "jterm-cccc3333", pane: "%9" },
];

describe("mirrorTabs", () => {
  it("rebuilds the peer's tabs with their titles and splits", () => {
    const mirror = mirrorTabs("gb10", { snapshot: peerSnapshot(), panes: PANES });
    expect(mirror.tabs).toHaveLength(2);
    const [first, second] = mirror.tabs;
    expect(first.title).toBe("CommandAGI");
    expect(isPeerTab(first)).toBe(true);
    expect(first.id.startsWith(peerTabPrefix("gb10"))).toBe(true);

    // The notepad is gone and its split collapsed around it, leaving the two
    // terminals stacked as they were over there.
    const a = controlPaneId("gb10:jterm-aaaa1111", "%3");
    const b = controlPaneId("gb10:jterm-bbbb2222", "%5");
    expect(paneIds(first.root)).toEqual([a, b]);
    expect(first.root.kind === "split" && first.root.axis).toBe("y");
    const boxes = place(first.root).panes;
    expect(boxes.map((box) => box.paneId)).toEqual([a, b]);

    expect(first.focusedPaneId).toBe(b);
    expect(first.panes[a]).toMatchObject({
      kind: "terminal",
      tmux: "gb10:jterm-aaaa1111",
      tmuxPane: "%3",
      cwd: "/repo",
      command: "claude",
    });
    expect(first.panes[b]).toMatchObject({ name: "server" });

    expect(second.title).toBeUndefined();
    expect(mirror.activeTabId).toBe(second.id);
    expect(mirror.sessions.sort()).toEqual([
      "gb10:jterm-aaaa1111",
      "gb10:jterm-bbbb2222",
      "gb10:jterm-cccc3333",
    ]);
  });

  it("is the same tabs and panes every time it is read", () => {
    // Derived ids are what stop a refresh from remounting every terminal.
    const one = mirrorTabs("gb10", { snapshot: peerSnapshot(), panes: PANES });
    const two = mirrorTabs("gb10", { snapshot: peerSnapshot(), panes: PANES });
    expect(two).toEqual(one);
  });

  it("leaves out a session split inside tmux, and one detached from", () => {
    const split = [...PANES, { session: "jterm-cccc3333", pane: "%10" }];
    const mirror = mirrorTabs(
      "gb10",
      { snapshot: peerSnapshot(), panes: split },
      new Set(["gb10:jterm-bbbb2222"]),
    );
    // The second tab had only the split session, so it is not shown at all.
    expect(mirror.tabs).toHaveLength(1);
    expect(paneIds(mirror.tabs[0].root)).toEqual([controlPaneId("gb10:jterm-aaaa1111", "%3")]);
    expect(mirror.sessions).toEqual(["gb10:jterm-aaaa1111"]);
  });

  it("finds nothing in a host without jterm, or with a snapshot it cannot read", () => {
    expect(mirrorTabs("gb10", { snapshot: null, panes: PANES }).tabs).toEqual([]);
    expect(mirrorTabs("gb10", { snapshot: "{not json", panes: PANES }).tabs).toEqual([]);
  });
});

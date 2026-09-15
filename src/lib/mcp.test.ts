import { describe, expect, it } from "vitest";

import { emptyWorkspace, reduce, type Workspace } from "@/state/workspace";
import { TOOLS, callTool, describeWorkspace, handleRequest, type ToolContext } from "./mcp";
import type { TerminalHandle } from "./terminals";

function harness() {
  let workspace: Workspace = emptyWorkspace();
  const sent: string[] = [];
  const pasted: string[] = [];
  const drafts: Record<string, string> = {};
  const opened: [string, string][] = [];
  const live = new Set<string>();
  const handle = (paneId: string): TerminalHandle => ({
    getSelection: () => "",
    paste: (text) => pasted.push(`${paneId}:${text}`),
    send: (data) => sent.push(`${paneId}:${data}`),
    focus: () => {},
    readText: (lines) => `last ${lines} of ${paneId}`,
  });
  let ids = 0;
  const context: ToolContext = {
    getWorkspace: () => workspace,
    dispatch: (action) => {
      workspace = reduce(workspace, action);
    },
    openPath: (path, target) => opened.push([path, target]),
    terminal: (paneId) => (live.has(paneId) ? handle(paneId) : null),
    newId: () => `new${(ids += 1)}`,
    setDraft: (paneId, text) => {
      drafts[paneId] = text;
    },
    splitDirection: () => "right",
    // Time passing is where a real terminal mounts; the fake one mounts on the
    // first wait, which is enough to exercise the wait.
    sleep: async () => {
      for (const tab of workspace.tabs) for (const id of Object.keys(tab.panes)) live.add(id);
    },
  };
  const first = () => workspace.tabs[0];
  const firstPane = () => first().focusedPaneId;
  return { context, sent, pasted, drafts, opened, live, first, firstPane, get: () => workspace };
}

const body = (result: { content: { text: string }[] }) => result.content[0].text;

describe("the MCP tools", () => {
  it("lists every tool with a schema", async () => {
    const { context } = harness();
    const listed = (await handleRequest("tools/list", {}, context)) as { tools: typeof TOOLS };
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_panes",
      "read_terminal",
      "send_to_terminal",
      "open_terminal",
      "open_file",
      "open_url",
      "focus_pane",
    ]);
    for (const tool of listed.tools) expect(tool.inputSchema.type).toBe("object");
    await expect(handleRequest("resources/list", {}, context)).rejects.toThrow();
  });

  it("describes the window with the focused pane marked", async () => {
    const { context, firstPane } = harness();
    const result = await callTool("list_panes", {}, context);
    const described = JSON.parse(body(result));
    expect(described.tabs).toHaveLength(1);
    expect(described.tabs[0].panes[0]).toMatchObject({
      id: firstPane(),
      kind: "terminal",
      focused: true,
      exited: false,
    });
    expect(describeWorkspace(context.getWorkspace()).popups).toEqual([]);
  });

  it("reads and types into a terminal that is running", async () => {
    const { context, live, firstPane, sent, pasted } = harness();
    const id = firstPane();

    const early = await callTool("read_terminal", { pane_id: id }, context);
    expect(early.isError).toBe(true);

    live.add(id);
    expect(body(await callTool("read_terminal", { pane_id: id, lines: 99999 }, context))).toContain(
      "last 5000 of",
    );

    await callTool("send_to_terminal", { pane_id: id, text: "ls -la", submit: true }, context);
    expect(pasted).toEqual([`${id}:ls -la`]);
    expect(sent).toEqual([`${id}:\r`]);

    await callTool("send_to_terminal", { pane_id: id, text: "", raw: true }, context);
    expect(sent.at(-1)).toBe(`${id}:`);
  });

  it("refuses to type into a shell that has exited", async () => {
    const { context, live, firstPane } = harness();
    const id = firstPane();
    live.add(id);
    context.dispatch({ type: "pane/meta", paneId: id, patch: { exited: true } });
    const result = await callTool("send_to_terminal", { pane_id: id, text: "x" }, context);
    expect(result.isError).toBe(true);
  });

  it("leaves a command at a new terminal's prompt unless told to run it", async () => {
    const { context, drafts, sent, get } = harness();
    await callTool("open_terminal", { command: "npm test", cwd: "/repo" }, context);
    expect(get().tabs).toHaveLength(2);
    expect(get().tabs[1].panes.new1).toMatchObject({ kind: "terminal", cwd: "/repo" });
    expect(drafts.new1).toBe("npm test");
    expect(sent).toEqual([]);

    await callTool("open_terminal", { command: "npm run dev\n", run: true, where: "pane" }, context);
    expect(drafts.new2).toBeUndefined();
    expect(sent).toEqual(["new2:npm run dev\r"]);
    // Split beside the focused pane, not a tab of its own.
    expect(get().tabs).toHaveLength(2);
  });

  it("opens files by absolute path only, and pages over http only", async () => {
    const { context, opened, get } = harness();
    expect((await callTool("open_file", { path: "src/x.ts" }, context)).isError).toBe(true);
    await callTool("open_file", { path: "/repo/README.md", where: "popup" }, context);
    expect(opened).toEqual([["/repo/README.md", "popup"]]);

    expect((await callTool("open_url", { url: "file:///etc/passwd" }, context)).isError).toBe(true);
    expect((await callTool("open_url", { url: "not a url" }, context)).isError).toBe(true);
    await callTool("open_url", { url: "http://localhost:5173" }, context);
    const pane = Object.values(get().tabs[1].panes)[0];
    expect(pane).toMatchObject({ kind: "browser", url: "http://localhost:5173/" });
  });

  it("focuses a pane in another tab", async () => {
    const { context, get } = harness();
    const original = get().tabs[0];
    await callTool("open_url", { url: "https://example.com" }, context);
    expect(get().activeTabId).not.toBe(original.id);
    await callTool("focus_pane", { pane_id: original.focusedPaneId }, context);
    expect(get().activeTabId).toBe(original.id);
    expect((await callTool("focus_pane", { pane_id: "nope" }, context)).isError).toBe(true);
  });

  it("answers an unknown tool or bad arguments as a tool error", async () => {
    const { context } = harness();
    expect((await callTool("rm_rf", {}, context)).isError).toBe(true);
    expect((await callTool("read_terminal", { pane_id: 5 }, context)).isError).toBe(true);
  });
});

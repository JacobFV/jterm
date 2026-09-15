/**
 * The tools jterm offers the agent in its sidebar, over MCP.
 *
 * The protocol is spoken in the backend (`src-tauri/src/mcp.rs`); everything
 * about *what* the tools are lives here, because the workspace they act on is
 * this window's state. The backend hands over `tools/list` and `tools/call`
 * and waits for the answer, so a tool is described and implemented in the one
 * place — there is no second schema in Rust to drift out of step with this.
 *
 * What is offered is what an agent inside a terminal app cannot already do
 * from its own shell: see the other panes, read what they show, type into
 * them, and put things on screen where the user is looking. Nothing here
 * closes a pane or kills a process. An agent that wants something gone can ask
 * the user, who can see the thing it wants gone.
 *
 * Written against `ToolContext` rather than against the app, so it can be run
 * in node with a workspace, a reducer and a few fakes.
 */

import type { FileOpenTarget } from "@/state/settings";
import { paneIds, splitPlacement, type Direction } from "@/state/tree";
import {
  activeTab,
  locatePane,
  paneLabel,
  tabLabel,
  type Action,
  type PaneKind,
  type PaneState,
  type Workspace,
} from "@/state/workspace";
import type { TerminalHandle } from "./terminals";

export interface ToolContext {
  getWorkspace(): Workspace;
  dispatch(action: Action): void;
  openPath(path: string, target: FileOpenTarget): void;
  terminal(paneId: string): TerminalHandle | null;
  newId(): string;
  /** Put a line at a new terminal's prompt, typed but not run. */
  setDraft(paneId: string, text: string): void;
  splitDirection(): Direction;
  sleep(ms: number): Promise<void>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** How long a new terminal is given to mount before it counts as not starting. */
const START_TIMEOUT_MS = 10_000;
/**
 * The pause between a new terminal existing and a command being typed into it.
 * Typed any earlier and the shell's line editor is not reading yet — the text
 * is echoed raw and the prompt lands on top of it. `TerminalPane` waits for the
 * prompt properly when replaying a draft, which is why `run: false` uses that.
 */
const RUN_SETTLE_MS = 900;
const DEFAULT_LINES = 200;
const MAX_LINES = 5000;

const WHERE = {
  type: "string",
  enum: ["tab", "pane", "popup"],
  description:
    "Where it appears: a new tab, a split beside the pane the user has focused, or a pop-up floating over the workspace. Defaults to tab.",
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_panes",
    title: "List tabs and panes",
    description:
      "Every tab and pop-up in this jterm window, and the panes in each: id, kind (terminal, notepad, browser, image, media, model), title, and for terminals the working directory, the last command started and whether the shell has exited. `focused` marks the pane the user is typing into.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_terminal",
    title: "Read a terminal",
    description:
      "The last lines a terminal pane holds — its scrollback and screen — as plain text, with wrapped lines joined back together.",
    inputSchema: {
      type: "object",
      properties: {
        pane_id: { type: "string", description: "A terminal pane's id, from list_panes." },
        lines: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LINES,
          description: `How many lines from the end. Defaults to ${DEFAULT_LINES}.`,
        },
      },
      required: ["pane_id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_to_terminal",
    title: "Type into a terminal",
    description:
      "Type text into a terminal pane, as if pasted. The user sees it happen. Set submit to press Enter afterwards. Set raw to send the text as keystrokes instead of a paste — for control characters such as \\u0003 (Ctrl-C).",
    inputSchema: {
      type: "object",
      properties: {
        pane_id: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after the text. Defaults to false." },
        raw: { type: "boolean", description: "Send as keystrokes rather than a paste." },
      },
      required: ["pane_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "open_terminal",
    title: "Open a terminal",
    description:
      "Open a new terminal pane and return its id. With a command, the command is typed at the prompt for the user to run — or run straight away if run is true. Prefer this to borrowing a terminal the user is working in.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute directory to start in." },
        command: { type: "string" },
        run: { type: "boolean", description: "Run the command rather than leaving it at the prompt." },
        where: WHERE,
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_file",
    title: "Open a file",
    description:
      "Open a file in jterm in the pane that suits it: text and code in an editor, images, video, 3D models and markdown in viewers.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "An absolute path." }, where: WHERE },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "open_url",
    title: "Open a web page",
    description:
      "Open an http or https URL in a browser pane inside jterm — a dev server, documentation, a preview.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, where: WHERE },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "focus_pane",
    title: "Focus a pane",
    description: "Bring a pane to the front and give it the keyboard, switching tabs if needed.",
    inputSchema: {
      type: "object",
      properties: { pane_id: { type: "string" } },
      required: ["pane_id"],
      additionalProperties: false,
    },
  },
];

/* ── Answering the backend ───────────────────────────────────────────────── */

/** A JSON-RPC method's result, or a throw for a method this does not serve. */
export async function handleRequest(
  method: string,
  params: unknown,
  context: ToolContext,
): Promise<unknown> {
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    const call = isRecord(params) ? params : {};
    const name = typeof call.name === "string" ? call.name : "";
    return callTool(name, call.arguments ?? {}, context);
  }
  throw new Error(`jterm does not serve ${method}`);
}

/**
 * Run one tool.
 *
 * A tool that fails answers with `isError` rather than throwing, which is how
 * MCP asks for it: a JSON-RPC error means the call could not be made at all,
 * while a tool error is something the model should read and act on — "that
 * pane has exited" is information, not a transport failure.
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const args = isRecord(rawArgs) ? rawArgs : {};
  try {
    switch (name) {
      case "list_panes":
        return text(JSON.stringify(describeWorkspace(context.getWorkspace()), null, 2));
      case "read_terminal":
        return readTerminal(args, context);
      case "send_to_terminal":
        return sendToTerminal(args, context);
      case "open_terminal":
        return await openTerminal(args, context);
      case "open_file":
        return openFile(args, context);
      case "open_url":
        return openUrl(args, context);
      case "focus_pane":
        return focusPane(args, context);
      default:
        return failure(`jterm has no tool called ${name || "(none)"}`);
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/* ── The tools ───────────────────────────────────────────────────────────── */

/** The window as the agent sees it: ids to act on, and enough to recognise them by. */
export function describeWorkspace(workspace: Workspace) {
  return {
    tabs: workspace.tabs.map((tab) => ({
      id: tab.id,
      title: tabLabel(tab),
      active: tab.id === workspace.activeTabId,
      // In the order the split tree lays them out, which is the order the
      // user reads them in, rather than the order they happened to be created.
      panes: paneIds(tab.root)
        .map((id) => tab.panes[id])
        .filter((pane): pane is PaneState => pane !== undefined)
        .map((pane) => ({
          ...describePane(pane),
          focused:
            workspace.focusedPopupId === null &&
            tab.id === workspace.activeTabId &&
            tab.focusedPaneId === pane.id,
        })),
    })),
    popups: workspace.popups.map((popup) => ({
      ...describePane(popup.pane),
      state: popup.state,
      focused: popup.pane.id === workspace.focusedPopupId,
    })),
  };
}

function describePane(pane: PaneState): Record<string, unknown> {
  const described: Record<string, unknown> = {
    id: pane.id,
    kind: pane.kind,
    title: paneLabel(pane),
  };
  if (pane.kind === "terminal") {
    if (pane.cwd) described.cwd = pane.cwd;
    if (pane.command) described.command = pane.command;
    described.exited = pane.exited === true;
  }
  if ("path" in pane && typeof pane.path === "string" && pane.path) described.path = pane.path;
  if (pane.kind === "browser") described.url = pane.url;
  return described;
}

function readTerminal(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const { pane, handle } = liveTerminal(args, context);
  const lines = clampInt(args.lines, 1, MAX_LINES, DEFAULT_LINES);
  const body = handle.readText(lines);
  return text(`${paneLabel(pane)} (${pane.id})${pane.exited ? " — shell has exited" : ""}\n\n${body}`);
}

function sendToTerminal(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const { pane, handle } = liveTerminal(args, context);
  if (pane.exited) throw new Error(`the shell in ${pane.id} has exited`);
  const input = requireString(args, "text");
  if (args.raw === true) handle.send(input);
  else if (input) handle.paste(input);
  if (args.submit === true) handle.send("\r");
  return text(`Sent to ${paneLabel(pane)} (${pane.id}).`);
}

async function openTerminal(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const cwd = optionalString(args, "cwd");
  const command = optionalString(args, "command")?.replace(/[\r\n]+$/, "");
  const run = args.run === true;
  const id = context.newId();

  if (command && !run) context.setDraft(id, command);
  place(context, "terminal", { id, ...(cwd ? { cwd } : {}) } as Partial<PaneState>, where(args));

  if (command && run) {
    const handle = await waitFor(() => context.terminal(id), context);
    if (handle === null) throw new Error(`terminal ${id} was opened but did not start in time`);
    await context.sleep(RUN_SETTLE_MS);
    handle.send(`${command}\r`);
  }
  const what = command ? (run ? `, running ${command}` : `, with ${command} at the prompt`) : "";
  return text(`Opened terminal ${id}${cwd ? ` in ${cwd}` : ""}${what}.`);
}

function openFile(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const path = requireString(args, "path");
  // A relative path would be relative to wherever the app was launched from,
  // which is nowhere the agent can know.
  if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) {
    throw new Error(`open_file needs an absolute path, not ${path}`);
  }
  context.openPath(path, where(args));
  return text(`Opened ${path}.`);
}

function openUrl(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const raw = requireString(args, "url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https pages can be opened, not ${url.protocol}`);
  }
  place(context, "browser", { url: url.href } as Partial<PaneState>, where(args));
  return text(`Opened ${url.href}.`);
}

function focusPane(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const paneId = requireString(args, "pane_id");
  const found = locatePane(context.getWorkspace(), paneId);
  if (found === null) throw new Error(`no pane ${paneId} in this window`);
  if (found.tabId === null) {
    context.dispatch({ type: "popup/focus", paneId });
  } else {
    context.dispatch({ type: "tab/select", tabId: found.tabId });
    context.dispatch({ type: "pane/focus", tabId: found.tabId, paneId });
  }
  return text(`Focused ${paneLabel(found.pane)} (${paneId}).`);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Put a new pane where the call asked for it, the way `App.openPath` does for a file. */
function place(context: ToolContext, kind: PaneKind, seed: Partial<PaneState>, target: FileOpenTarget) {
  if (target === "popup") {
    context.dispatch({ type: "popup/open", kind, seed });
    return;
  }
  const tab = activeTab(context.getWorkspace());
  if (target === "pane" && tab) {
    const { axis, before } = splitPlacement(context.splitDirection());
    context.dispatch({
      type: "pane/split",
      tabId: tab.id,
      paneId: tab.focusedPaneId,
      axis,
      before,
      kind,
      seed,
    });
    return;
  }
  context.dispatch({ type: "tab/open", kind, seed });
}

function where(args: Record<string, unknown>): FileOpenTarget {
  return args.where === "pane" || args.where === "popup" ? args.where : "tab";
}

function liveTerminal(args: Record<string, unknown>, context: ToolContext) {
  const paneId = requireString(args, "pane_id");
  const found = locatePane(context.getWorkspace(), paneId);
  if (found === null) throw new Error(`no pane ${paneId} in this window`);
  if (found.pane.kind !== "terminal") {
    throw new Error(`${paneId} is a ${found.pane.kind} pane, not a terminal`);
  }
  const handle = context.terminal(paneId);
  if (handle === null) throw new Error(`terminal ${paneId} is not running yet`);
  return { pane: found.pane, handle };
}

async function waitFor<T>(probe: () => T | null, context: ToolContext): Promise<T | null> {
  const step = 100;
  for (let waited = 0; waited <= START_TIMEOUT_MS; waited += step) {
    const value = probe();
    if (value !== null) return value;
    await context.sleep(step);
  }
  return null;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value || undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sidebar's Agent tab: Claude Code, Codex or Gemini CLI, running beside the
 * workspace and connected to jterm itself.
 *
 * The agent is whichever one Settings names, started in the directory the
 * sidebar is following, and it is always started with jterm's MCP server — see
 * `src-tauri/src/agent_cli.rs` for how each CLI is told, and `lib/mcp.ts` for
 * what it can then do. That connection is what makes this more than a terminal
 * squeezed into the sidebar: the agent can see the other panes, read what the
 * build just printed, and open what it made where the user will look.
 *
 * Three rules this shares with `TerminalPane`, for the same reasons:
 *
 *   - **Never unmounted by the layout.** Switching sidebar tabs, or closing the
 *     sidebar, hides this. The agent is a process with a conversation in it, and
 *     `Sidebar` keeps the component mounted for as long as the window exists.
 *   - **Adopted, not restarted, after a reload.** A webview that reloads (see
 *     `recover.rs`) remounts this against an agent that never stopped; spawning
 *     would kill it, so `pty.attach` is asked first.
 *   - **Not resized to nothing when hidden.** A hidden element measures 0×0, and
 *     fitting to that would tell the agent its terminal is one column wide.
 *
 * Nothing is started until the tab is first opened. An agent is a paid-for,
 * logged-in process, and launching one for every window on every start because
 * the sidebar happened to be on this tab last time would be a surprise.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { splitArgs } from "@/lib/argv";
import { agentPty, openExternal, pty } from "@/lib/ipc";
import { isLinkActivation, linkTarget } from "@/lib/links";
import { programById } from "@/lib/programs";
import { ready as ptyBusReady, subscribePty } from "@/lib/ptyBus";
import { isTauri } from "@/lib/tauri";
import { useSettings } from "@/lib/useSettings";
import { currentWindowLabel } from "@/lib/windows";
import { pixelGeometry, readTheme } from "@/panes/TerminalPane";
import { getSettings, subscribeSettings, type Settings } from "@/state/settings";
import { HeaderButton, SidebarHeader, baseName, errorText } from "./SidebarChrome";

/**
 * The agent's pty id for a window. One agent per window, and a pane id rather
 * than a random one so a reloaded window finds the agent it already had.
 */
export function agentPaneId(windowLabel: string): string {
  return `sidebar-agent-${windowLabel.replace(/[^A-Za-z0-9-]/g, "-")}`.slice(0, 64);
}

/** What the terminal is drawn with, so a settings change that moves none of it is ignored. */
function appearanceKey(settings: Settings): string {
  return [
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.scrollback,
    settings.theme,
  ].join("|");
}

type AgentState = "starting" | "running" | "exited";

export function SidebarAgent({
  cwd,
  active,
  theme,
  switcher,
}: {
  cwd: string;
  active: boolean;
  /** The window's theme, so the terminal re-reads its palette when it moves. */
  theme: string;
  switcher: ReactNode;
}) {
  const settings = useSettings();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const exitedRef = useRef(true);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const [state, setState] = useState<AgentState>("starting");
  const [running, setRunning] = useState<{ tool: string; cwd: string } | null>(null);
  const id = useMemo(() => agentPaneId(currentWindowLabel()), []);

  /** Start the agent, or pick up the one this window already has. */
  const start = useCallback(
    async (restart: boolean) => {
      const term = termRef.current;
      if (term === null) return;
      await ptyBusReady();
      const geometry = pixelGeometry(hostRef.current);

      if (!restart) {
        const adopted = await pty.attach(id, term.cols, term.rows, geometry);
        if (adopted) {
          exitedRef.current = false;
          setState("running");
          setRunning({ tool: getSettings().agentTool, cwd: adopted.cwd });
          return;
        }
      } else {
        term.reset();
      }

      const current = getSettings();
      const tool = current.agentTool;
      setState("starting");
      try {
        if (!isTauri()) throw new Error("The agent runs in the desktop app, not in a browser tab.");
        const info = await agentPty.spawn({
          id,
          cols: term.cols,
          rows: term.rows,
          ...geometry,
          cwd: cwdRef.current,
          shell: current.shell || undefined,
          tool,
          command: splitArgs(current.agentCommand),
          args: splitArgs(current.agentArgs),
        });
        exitedRef.current = false;
        setState("running");
        setRunning({ tool, cwd: info?.cwd ?? cwdRef.current });
      } catch (failure) {
        exitedRef.current = true;
        setState("exited");
        term.write(
          `\x1b[31m${errorText(failure)}\x1b[0m\r\n\r\n` +
            `\x1b[2mCheck the agent in Settings → Agent, then press Enter to try again.\x1b[0m\r\n`,
        );
      }
    },
    [id],
  );
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const initial = getSettings();

    const followLink = (event: MouseEvent, uri: string) => {
      if (!isLinkActivation(event)) return;
      const target = linkTarget(uri);
      if (target !== null) void openExternal(target);
    };

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: initial.cursorBlink,
      cursorStyle: initial.cursorStyle,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
      fontSize: initial.fontSize,
      lineHeight: initial.lineHeight,
      scrollback: initial.scrollback,
      theme: readTheme(host),
      linkHandler: { activate: followLink },
      macOptionIsMeta: true,
      ...(navigator.userAgent.includes("Windows")
        ? { windowsPty: { backend: "conpty" as const } }
        : {}),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon(followLink));
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(host);
    termRef.current = term;

    const safeFit = () => {
      // Hidden — another tab is showing, or the sidebar is closed. Keeping the
      // size it had is the whole point; see the note at the top.
      if (host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        fit.fit();
      } catch {
        /* A size xterm rejects, mid-transition. The next observation fixes it. */
      }
    };
    safeFit();

    const unsubscribe = subscribePty(
      id,
      (chunk) => term.write(chunk),
      (code) => {
        exitedRef.current = true;
        setState("exited");
        term.write(
          `\r\n\x1b[2m[agent exited${code === null ? "" : ` with ${code}`}] — press Enter to start it again\x1b[0m\r\n`,
        );
      },
    );

    const dataSub = term.onData((data) => {
      if (exitedRef.current) {
        if (data.includes("\r") || data.includes("\n")) void startRef.current(true);
        return;
      }
      void pty.write(id, data);
    });
    const binarySub = term.onBinary((data) => {
      if (!exitedRef.current) void pty.write(id, data);
    });

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const before = `${term.cols}x${term.rows}`;
        safeFit();
        if (!exitedRef.current && `${term.cols}x${term.rows}` !== before) {
          void pty.resize(id, term.cols, term.rows, pixelGeometry(host));
        }
      });
    });
    observer.observe(host);

    let look = appearanceKey(initial);
    const stopSettings = subscribeSettings((next) => {
      const key = appearanceKey(next);
      if (key === look) return;
      look = key;
      term.options.fontFamily = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim();
      term.options.fontSize = next.fontSize;
      term.options.lineHeight = next.lineHeight;
      term.options.cursorStyle = next.cursorStyle;
      term.options.cursorBlink = next.cursorBlink;
      term.options.scrollback = next.scrollback;
      term.options.theme = readTheme(host);
      safeFit();
      if (!exitedRef.current) void pty.resize(id, term.cols, term.rows, pixelGeometry(host));
    });

    void startRef.current(false);

    return () => {
      stopSettings();
      observer.disconnect();
      cancelAnimationFrame(frame);
      unsubscribe();
      dataSub.dispose();
      binarySub.dispose();
      term.dispose();
      termRef.current = null;
      // The agent is not killed here. This cleanup also runs when the webview
      // reloads, and the agent is meant to survive that; it is ended when the
      // window closes (see `App`) or when it is restarted.
    };
  }, [id]);

  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.theme = readTheme(hostRef.current);
    if (term.rows > 0) term.refresh(0, term.rows - 1);
  }, [theme]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  const shownTool = running?.tool ?? settings.agentTool;
  const label = programById(shownTool)?.label ?? shownTool;
  const switching = running !== null && running.tool !== settings.agentTool;
  const restartLabel = switching
    ? `Restart as ${programById(settings.agentTool)?.label ?? settings.agentTool} in ${cwd}`
    : `Restart in ${cwd}`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <SidebarHeader
        switcher={switcher}
        title={
          <>
            {label}
            {running ? <span className="text-ink-4"> · {baseName(running.cwd)}</span> : null}
            {state === "starting" ? <span className="text-ink-4"> · starting</span> : null}
          </>
        }
        hint={running?.cwd ?? cwd}
      >
        <HeaderButton
          label={restartLabel}
          active={switching}
          onClick={() => {
            void (async () => {
              exitedRef.current = true;
              await pty.kill(id);
              await startRef.current(true);
            })();
          }}
        >
          <RotateCw className="h-3 w-3" />
        </HeaderButton>
      </SidebarHeader>
      <div ref={hostRef} className="pane-ground min-h-0 flex-1 overflow-hidden pl-1.5 pt-1" />
    </div>
  );
}

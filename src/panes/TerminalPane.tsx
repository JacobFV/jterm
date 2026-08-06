/**
 * A shell in a pane.
 *
 * Most of this file is xterm.js wiring. The parts worth reading are:
 *
 *   - **Restoring a draft** (`armReplay`). The saved command line is typed back
 *     into the shell after its prompt appears, never with a newline, so it
 *     comes back as a line you can look at and edit rather than something the
 *     app ran on your behalf. Waiting for the prompt matters: written too
 *     early, readline is not listening yet and the text is simply lost.
 *   - **Not tracking a draft that is not a draft** (`altScreen`). Inside `vim`
 *     or `less` the keystrokes are commands, not a command line, and mirroring
 *     them would put `:wq` in the file we restore from. Entering the alternate
 *     screen buffer suspends tracking; leaving it resumes.
 *   - **Sizing.** A pane that is not visible still has a size, deliberately —
 *     see `PaneGrid` — so its shell is never told the window is 0×0 and never
 *     re-wraps its output while you are not looking.
 */

import { useCallback, useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";

import { applyInput, draftFrom, emptyDraft, replayBytes, type Draft } from "@/lib/draft";
import { pty, scrollback as scrollbackApi } from "@/lib/ipc";
import { scanOsc } from "@/lib/osc";
import { ready as ptyBusReady, subscribePty } from "@/lib/ptyBus";
import { registerTerminal } from "@/lib/terminals";
import { getContent, updateContent } from "@/state/content";
import type { TerminalPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

/**
 * Quiet time after the shell's last output before a draft is typed back.
 *
 * The prompt is the thing being waited for and there is no event for it, so
 * "output stopped arriving" stands in. Long enough that a prompt printed in two
 * writes is not mistaken for two prompts; short enough not to be seen.
 */
const REPLAY_SETTLE_MS = 180;
/** Give up waiting for a prompt that never comes. */
const REPLAY_DEADLINE_MS = 3000;

function readTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--term-bg"),
    foreground: token("--term-fg"),
    cursor: token("--term-cursor"),
    cursorAccent: token("--term-bg"),
    selectionBackground: token("--term-selection"),
    black: token("--term-black"),
    red: token("--term-red"),
    green: token("--term-green"),
    yellow: token("--term-yellow"),
    blue: token("--term-blue"),
    magenta: token("--term-magenta"),
    cyan: token("--term-cyan"),
    white: token("--term-white"),
    brightBlack: token("--term-bright-black"),
    brightRed: token("--term-bright-red"),
    brightGreen: token("--term-bright-green"),
    brightYellow: token("--term-bright-yellow"),
    brightBlue: token("--term-bright-blue"),
    brightMagenta: token("--term-bright-magenta"),
    brightCyan: token("--term-bright-cyan"),
    brightWhite: token("--term-bright-white"),
  };
}

export function TerminalPane({ pane, focused, onMeta, onFocus }: PaneProps<TerminalPaneState>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const draftRef = useRef<Draft>(emptyDraft());
  const altScreenRef = useRef(false);
  const oscCarryRef = useRef("");
  const exitedRef = useRef(false);
  const replayRef = useRef<{ text: string; settle: number; deadline: number } | null>(null);

  // Read once: the pane's id and its restored state are fixed for the lifetime
  // of this component, and the effect below must not re-run when a title or a
  // directory changes underneath it.
  const paneId = pane.id;
  const initialRef = useRef({ cwd: pane.cwd, draft: getContent(paneId).draft ?? "" });
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;

  /** Start (or restart) the shell and wire the terminal to it. */
  const spawn = useCallback(async (cwd: string | undefined) => {
    const term = termRef.current;
    if (!term) return;

    exitedRef.current = false;
    await ptyBusReady();
    const info = await pty.spawn({
      id: paneId,
      cols: term.cols,
      rows: term.rows,
      cwd,
    });
    if (info) metaRef.current({ cwd: info.cwd, exited: false });
  }, [paneId]);

  /** Send the pending draft to the shell, once and once only. */
  const fireReplay = useCallback(() => {
    const pending = replayRef.current;
    if (pending === null) return;
    replayRef.current = null;
    window.clearTimeout(pending.settle);
    window.clearTimeout(pending.deadline);

    const bytes = replayBytes(pending.text);
    if (!bytes) return;
    void pty.write(paneId, bytes);
    // The shell owns the line now, and its echo is the record of it; the mirror
    // is reset to match what was actually sent.
    draftRef.current = draftFrom(pending.text);
  }, [paneId]);

  /**
   * Queue the saved command line to be typed back in.
   *
   * The trigger is *the shell going quiet after having said something*, not
   * merely time passing. That distinction is the whole of it: a shell that is
   * slow to start — three of them are starting at once after a restore — has
   * not printed its prompt yet, and readline is not reading. Text written then
   * is swallowed by the tty and echoed raw, and the prompt arrives on top of
   * it. So `deadline` is a backstop for a shell that never prints anything,
   * and the ordinary path waits for output first.
   */
  const armReplay = useCallback(
    (text: string) => {
      if (!text || !replayBytes(text)) return;
      replayRef.current = {
        text,
        settle: 0,
        deadline: window.setTimeout(fireReplay, REPLAY_DEADLINE_MS),
      };
    },
    [fireReplay],
  );

  const cancelReplay = useCallback(() => {
    const pending = replayRef.current;
    if (pending === null) return;
    replayRef.current = null;
    window.clearTimeout(pending.settle);
    window.clearTimeout(pending.deadline);
  }, []);

  /** Restart the settle countdown; the shell is still talking. */
  const bumpReplay = useCallback(() => {
    const pending = replayRef.current;
    if (pending === null) return;
    window.clearTimeout(pending.settle);
    pending.settle = window.setTimeout(fireReplay, REPLAY_SETTLE_MS);
  }, [fireReplay]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim(),
      fontSize: 13,
      lineHeight: 1.25,
      // xterm keeps its own scrollback for the live session; the file on disk
      // is what survives a restart, and is capped separately.
      scrollback: 10_000,
      theme: readTheme(),
      macOptionIsMeta: true,
      // ConPTY re-wraps lines itself and reports the cursor differently from a
      // Unix pty; telling xterm which backend is behind it is what keeps
      // reflow and line endings right on Windows. `portable-pty` uses ConPTY.
      ...(navigator.userAgent.includes("Windows")
        ? { windowsPty: { backend: "conpty" as const } }
        : {}),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    /**
     * Repaint everything on screen.
     *
     * Needed more often than it should be. A renderer swap leaves the canvas
     * holding whatever it had, and the terminal has no reason of its own to
     * redraw until the next byte arrives — so a pane whose shell has already
     * printed its prompt and gone quiet can sit there blank until you type at
     * it. That happens in practice: WebGL contexts are a limited resource, and
     * opening a 3D model pane can take one away from a terminal.
     */
    const repaint = () => {
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    };

    // WebGL is a large speed-up for output-heavy work but is not available in
    // every webview this ships to, and a failure here must not take the pane
    // down — the DOM renderer is a correct fallback, only slower.
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            // Disposing hands rendering back to the DOM renderer, which starts
            // from an empty canvas and must be told what is on screen.
            webgl.dispose();
            repaint();
          });
          term.loadAddon(webgl);
          repaint();
        } catch {
          /* Fall back to the default renderer. */
        }
      })
      .catch(() => {});

    const safeFit = () => {
      if (host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        fit.fit();
      } catch {
        /* A pane mid-transition can briefly have a size xterm rejects. */
      }
    };
    safeFit();

    // Keystrokes on their way to the shell, mirrored on the way past.
    const dataSub = term.onData((data) => {
      if (exitedRef.current) {
        // A dead pane is not a dead end: Enter starts a new shell in it.
        if (data.includes("\r") || data.includes("\n")) {
          term.write("\r\n");
          void spawn(initialRef.current.cwd);
        }
        return;
      }
      cancelReplay();
      void pty.write(paneId, data);
      if (!altScreenRef.current) {
        draftRef.current = applyInput(draftRef.current, data);
        updateContent(paneId, { draft: draftRef.current.text });
      }
    });

    const binarySub = term.onBinary((data) => {
      if (!exitedRef.current) void pty.write(paneId, data);
    });

    // Full-screen programs take over the keyboard; what is typed into them is
    // not a command line and must not be recorded as one.
    const bufferSub = term.buffer.onBufferChange(() => {
      const alternate = term.buffer.active.type === "alternate";
      altScreenRef.current = alternate;
      if (alternate) {
        draftRef.current = emptyDraft();
        updateContent(paneId, { draft: "" });
      }
    });

    const unsubscribe = subscribePty(
      paneId,
      (chunk) => {
        term.write(chunk);
        bumpReplay();

        const scan = scanOsc(chunk, oscCarryRef.current);
        oscCarryRef.current = scan.carry;
        if (scan.cwd || scan.title) {
          metaRef.current({
            ...(scan.cwd ? { cwd: scan.cwd } : {}),
            ...(scan.title ? { title: scan.title } : {}),
          });
        }
      },
      (code) => {
        exitedRef.current = true;
        cancelReplay();
        metaRef.current({ exited: true });
        term.write(
          `\r\n\x1b[2m[process exited${code === null ? "" : ` with ${code}`}] — press Enter to start a new shell\x1b[0m\r\n`,
        );
      },
    );

    // Reachable from the global shortcuts, which have no other way in.
    const unregister = registerTerminal(paneId, {
      getSelection: () => term.getSelection(),
      paste: (text) => term.paste(text),
      send: (data) => {
        if (!exitedRef.current) void pty.write(paneId, data);
      },
      focus: () => term.focus(),
    });

    // Sizing follows the pane, and the shell follows the sizing.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        safeFit();
        repaint();
        if (!exitedRef.current) void pty.resize(paneId, term.cols, term.rows);
      });
    });
    observer.observe(host);

    let disposed = false;
    void (async () => {
      // Scrollback first, so the shell's new prompt lands underneath the
      // output it is continuing from rather than on top of it.
      const previous = await scrollbackApi.read(paneId);
      if (disposed) return;
      if (previous) {
        term.write(previous);
        term.write("\x1b[0m\r\n\x1b[2m── session restored ──\x1b[0m\r\n");
      }
      await spawn(initialRef.current.cwd);
      if (disposed) return;
      armReplay(initialRef.current.draft);
      // The prompt lands shortly after this; a repaint once the pane has
      // settled is what makes a restored session look restored rather than
      // empty.
      window.setTimeout(repaint, 250);
    })();

    return () => {
      disposed = true;
      cancelReplay();
      observer.disconnect();
      cancelAnimationFrame(frame);
      unregister();
      unsubscribe();
      dataSub.dispose();
      binarySub.dispose();
      bufferSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      // The shell itself is ended by whoever closed the pane, not here: this
      // cleanup also runs on an ordinary unmount, and killing a shell because
      // React re-rendered would be a very expensive bug.
    };
  }, [paneId, armReplay, bumpReplay, cancelReplay, spawn]);

  // Focus follows the app's idea of the focused pane, not the DOM's, so
  // clicking a tab returns the caret to wherever it was in that tab.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div
      className="h-full w-full overflow-hidden bg-surface-0 px-1.5 pt-1"
      onMouseDown={onFocus}
      ref={hostRef}
    />
  );
}

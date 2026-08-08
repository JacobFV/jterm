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
import { history, pty, scrollback as scrollbackApi } from "@/lib/ipc";
import { scanOsc } from "@/lib/osc";
import { ready as ptyBusReady, subscribePty } from "@/lib/ptyBus";
import { registerTerminal } from "@/lib/terminals";
import { getContent, updateContent } from "@/state/content";
import { getSettings, subscribeSettings } from "@/state/settings";
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

/**
 * How long typing must pause before the unsubmitted line is written to the
 * terminal's log. A record per keystroke would make the log mostly prefixes of
 * itself, and the crash-recovery snapshot already covers the last few hundred
 * milliseconds far more cheaply.
 */
const DRAFT_LOG_INTERVAL_MS = 1200;

/**
 * How often a visible shell is asked where it actually is.
 *
 * `cd` is not something a terminal can observe. The shell changes its own
 * working directory and nothing is written to the pty about it — the only
 * announcement is OSC 7, which shells emit *if their prompt is configured to*,
 * and a stock bash is not. So the directory is read from the process itself
 * (`/proc/<pid>/cwd` on Linux) on a timer, with OSC 7 still handled when it
 * does arrive because it is the only mechanism that works on macOS and Windows.
 *
 * A `readlink` per visible pane per interval is cheap enough to be invisible
 * and this is what keeps the file tree pointed at the directory you are in.
 */
const CWD_POLL_MS = 1500;

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

export function TerminalPane({ pane, focused, visible, onMeta, onFocus }: PaneProps<TerminalPaneState>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const draftRef = useRef<Draft>(emptyDraft());
  const altScreenRef = useRef(false);
  const oscCarryRef = useRef("");
  const exitedRef = useRef(false);
  const replayRef = useRef<{ text: string; settle: number; deadline: number } | null>(null);
  /** Where the shell was when the last command was submitted, for the log. */
  const cwdRef = useRef<string | undefined>(pane.cwd);
  /** Coalesces draft records; every keystroke would be a line per character. */
  const draftLogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // Read at spawn rather than held, so changing it in Settings applies to
      // the next shell started — including the one Enter starts in a pane
      // whose shell has exited — and leaves running shells alone.
      shell: getSettings().shell || undefined,
    });
    if (info) {
      cwdRef.current = info.cwd;
      metaRef.current({ cwd: info.cwd, exited: false });
      void history.append(paneId, {
        kind: "spawn",
        at: new Date().toISOString(),
        shell: info.shell,
        cwd: info.cwd,
        pid: info.pid,
      });
    }
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

  /** Read the shell's real working directory and report it if it moved. */
  const checkCwd = useCallback(() => {
    if (exitedRef.current) return;
    void pty.cwd(paneId).then((cwd) => {
      if (!cwd || cwd === cwdRef.current) return;
      cwdRef.current = cwd;
      metaRef.current({ cwd });
      void history.append(paneId, {
        kind: "cwd",
        at: new Date().toISOString(),
        path: cwd,
      });
    });
  }, [paneId]);

  // Only while the pane is on screen: a backgrounded tab's directory is not
  // being looked at, and it is re-read the moment it comes back.
  useEffect(() => {
    if (!visible) return;
    checkCwd();
    const timer = setInterval(checkCwd, CWD_POLL_MS);
    return () => clearInterval(timer);
  }, [visible, checkCwd]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const settings = getSettings();
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      // Read from the variable rather than from the setting: `lib/appearance`
      // is where a chosen family gets the built-in stack put behind it, and the
      // terminal should be looking at the same resolved value as the chrome.
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim(),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      // xterm keeps its own scrollback for the live session; the file on disk
      // is what survives a restart, and is capped separately.
      scrollback: settings.scrollback,
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
     * A terminal has no reason of its own to redraw until the next byte
     * arrives, so a pane whose shell has printed its prompt and gone quiet can
     * sit there showing nothing if a repaint was missed while it was being laid
     * out. Cheap, and called at the two moments where that is possible.
     */
    const repaint = () => {
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    };

    // No WebGL renderer, deliberately.
    //
    // It is a large speed-up for firehose output and it was loaded here at
    // first. It has to go, because of how it interacts with the rest of this
    // app on Linux: NVIDIA's driver forces WEBKIT_DISABLE_DMABUF_RENDERER (see
    // src-tauri/src/main.rs), and a WebKit that has been pushed off its
    // accelerated path is a bad host for a second GL surface — every keystroke
    // has to make it through that path before the echo is visible. It also cost
    // a bug earlier: contexts are a limited resource, so opening a 3D pane
    // could take one away from a terminal and leave it blank.
    //
    // xterm's DOM renderer has none of those failure modes and is quick enough
    // for anything short of `yes`. Correct on every platform beats fast on one.

    const safeFit = () => {
      if (host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        fit.fit();
      } catch {
        /* A pane mid-transition can briefly have a size xterm rejects. */
      }
    };
    safeFit();

    /**
     * Push the settings onto a terminal that already exists.
     *
     * Type size is the interesting one: changing it changes the size of a cell,
     * so the same pane is suddenly a different number of columns and rows, and
     * a shell that is not told re-wraps its output against the old width. Hence
     * the refit and the resize — a font change is a window resize as far as
     * anything on the other end of the pty is concerned.
     */
    const applySettings = () => {
      const current = getSettings();
      term.options.fontFamily = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim();
      term.options.fontSize = current.fontSize;
      term.options.lineHeight = current.lineHeight;
      term.options.cursorStyle = current.cursorStyle;
      term.options.cursorBlink = current.cursorBlink;
      term.options.scrollback = current.scrollback;
      term.options.theme = readTheme();
      safeFit();
      repaint();
      if (!exitedRef.current) void pty.resize(paneId, term.cols, term.rows);
    };
    const stopSettings = subscribeSettings(applySettings);

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
      if (altScreenRef.current) return;

      // Recorded before the input is applied: `applyInput` clears the line on
      // Enter, so afterwards there is nothing left to write down.
      const submitting = data.includes("\r") || data.includes("\n");
      const submitted = draftRef.current.text;

      draftRef.current = applyInput(draftRef.current, data);
      updateContent(paneId, { draft: draftRef.current.text });

      if (submitting && submitted.trim()) {
        void history.append(paneId, {
          kind: "command",
          at: new Date().toISOString(),
          text: submitted,
          cwd: cwdRef.current,
          // The mirror loses track after tab completion or history recall, and
          // a log that does not say so is worse than one that does.
          exact: draftRef.current.trusted,
        });
        // `cd` is the most likely thing to have just happened; asking now makes
        // the tree follow it immediately rather than up to a poll later.
        window.setTimeout(checkCwd, 120);
      }

      // The unsubmitted line, on a timer. This is what makes the terminal's own
      // file a complete record rather than only a list of what ran.
      if (draftLogTimer.current !== null) clearTimeout(draftLogTimer.current);
      draftLogTimer.current = setTimeout(() => {
        draftLogTimer.current = null;
        void history.append(paneId, {
          kind: "draft",
          at: new Date().toISOString(),
          text: draftRef.current.text,
        });
      }, DRAFT_LOG_INTERVAL_MS);
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
        if (scan.cwd && scan.cwd !== cwdRef.current) {
          cwdRef.current = scan.cwd;
          void history.append(paneId, {
            kind: "cwd",
            at: new Date().toISOString(),
            path: scan.cwd,
          });
        }
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
        void history.append(paneId, {
          kind: "exit",
          at: new Date().toISOString(),
          code,
        });
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
      stopSettings();
      if (draftLogTimer.current !== null) clearTimeout(draftLogTimer.current);
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
  }, [paneId, armReplay, bumpReplay, cancelReplay, checkCwd, spawn]);

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

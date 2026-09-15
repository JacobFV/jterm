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
 *   - **Standing down for tmux** (`sessionRef`). When the pane is backed by a
 *     tmux session, none of the first two happen. tmux redraws the screen on
 *     attach, so replaying a log over the top would paint a stale picture that
 *     the redraw then argues with; and the shell that has the half-typed line
 *     is still running, so there is nothing to type back — the real line comes
 *     back on its own, which is better than a reconstruction of it. The draft
 *     mirror keeps running regardless, because it is also what the command log
 *     is built from and tmux keeps no such log.
 *   - **Offering, not doing** (`usePaneSuggestions`). A pane that came back
 *     without its shell used to have its last session typed at the prompt.
 *     It now shows buttons — resume that agent's conversation, keep shells on
 *     tmux — and this file supplies the few things those buttons may do to the
 *     shell (`controlsRef`).
 */

import { useCallback, useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";

import { applyInput, draftFrom, emptyDraft, replayBytes, type Draft } from "@/lib/draft";
import {
  history,
  openExternal,
  pty,
  scrollback as scrollbackApi,
  tmux as tmuxApi,
  tmuxControl as tmuxControlApi,
} from "@/lib/ipc";
import { isLinkActivation, linkTarget } from "@/lib/links";
import { scanOsc } from "@/lib/osc";
import { ready as ptyBusReady, subscribePty } from "@/lib/ptyBus";
import { restoreBanner } from "@/lib/scrollback";
import { registerTerminal, tailText } from "@/lib/terminals";
import { sessionNameFor, tmuxAvailable } from "@/lib/tmux";
import { getContent, updateContent } from "@/state/content";
import { getSettings, subscribeSettings } from "@/state/settings";
import type { TerminalPaneState } from "@/state/workspace";
import { SuggestionCards } from "@/components/shell/SuggestionCards";
import type { PaneProps } from "./types";
import { type ShellControls, usePaneSuggestions } from "./usePaneSuggestions";

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

/**
 * How often, at most, the rendered screen is written down while output arrives.
 *
 * This is what a pane whose shell died is restored *from* — see `save_screen` in
 * `store.rs` for why the raw log is not. A throttle rather than a debounce: an
 * agent's spinner never goes quiet, and a debounce would never fire for exactly
 * the panes that most need it. Three seconds is inside the backend's slack for
 * preferring the screen, and serialising a pane that often costs nothing anyone
 * would see.
 */
const SCREEN_SAVE_MS = 3000;
/**
 * Rows of history kept with the screen. The emulator's own scrollback can be
 * far longer, and restoring all of it would make every relaunch parse megabytes
 * per pane for history hardly anyone scrolls back to.
 */
const SCREEN_ROWS = 2000;

/**
 * How long moving a shell into tmux waits for the old one to be gone.
 *
 * The new shell cannot start first: the old one's reader thread, on its way
 * out, takes the pane's id out of the registry, and a new session registered
 * under that id before then would be the one removed. Its exit event is the
 * signal that it has finished. This is only the backstop for one that never
 * arrives.
 */
const MOVE_EXIT_WAIT_MS = 3000;

/**
 * The palette this pane is standing in, as xterm wants it.
 *
 * Read from the pane's own element rather than from the document, because a
 * theme can now be chosen for one pane alone: `Workspace` writes the tokens
 * onto the pane's box, and every one of them inherits, so computing from here
 * gives the nearest theme — the pane's if it has one, else its tab's, else the
 * app's — without this file having to know that any of those levels exist.
 *
 * xterm copies these values into its own styles at the moment it is given them,
 * so unlike everything else on screen it has to be told again when they move.
 */
export function readTheme(host: HTMLElement | null): ITheme {
  const styles = getComputedStyle(host ?? document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--term-bg"),
    foreground: token("--term-fg"),
    cursor: token("--term-cursor"),
    // The solid one: this is the colour the character *under* a block cursor is
    // drawn in, and a translucent theme would leave it reading through to the
    // backdrop rather than against the cursor.
    cursorAccent: token("--term-bg-solid"),
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

/**
 * Everything a terminal is drawn with that comes from outside it, as xterm takes
 * it.
 *
 * Read afresh rather than taken off the settings object, because two of these —
 * the font stack and the palette — are resolved on the DOM, and a setting is not
 * the only thing that moves them: a pane's or a tab's theme does too.
 */
function appearanceOptions(host: HTMLElement, fontSize: number | undefined) {
  const settings = getSettings();
  return {
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
    fontSize: fontSize ?? settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    theme: readTheme(host),
  };
}

/**
 * The pane's drawing area in pixels, for the pty's `ws_xpixel`/`ws_ypixel`.
 *
 * The other half of telling programs how big a cell is. A terminal can be
 * asked directly (`CSI 14 t`, `CSI 16 t`, which xterm answers now that the
 * image addon is loaded), but a query needs a program willing to wait for a
 * reply, and inside tmux it does not get one — tmux answers for itself. What
 * every one of them falls back to is `TIOCGWINSZ`, which carries a pixel size
 * beside the character size, and which tmux *does* pass down to its panes from
 * the client that owns them. So a pane whose pty knows its pixel size can show
 * an image through tmux, and one that reports zeros — the field's "unknown",
 * and what jterm sent until now — cannot.
 *
 * Measured off `.xterm-screen`, which the renderer sizes to exactly the
 * dimensions its own `CSI 14 t` reply quotes, so the two answers agree. CSS
 * pixels, not device pixels, for the same reason: that is the unit xterm
 * reports in, and an image scaled for the other one comes out at half or twice
 * the size it should be.
 */
export function pixelGeometry(host: HTMLElement | null): { pixelWidth: number; pixelHeight: number } {
  const screen = host?.querySelector<HTMLElement>(".xterm-screen");
  return {
    pixelWidth: Math.round(screen?.clientWidth ?? 0),
    pixelHeight: Math.round(screen?.clientHeight ?? 0),
  };
}

export function TerminalPane({
  pane,
  theme,
  focused,
  visible,
  onMeta,
  onFocus,
}: PaneProps<TerminalPaneState>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const draftRef = useRef<Draft>(emptyDraft());
  const altScreenRef = useRef(false);
  const oscCarryRef = useRef("");
  /**
   * When the running command started, if the shell said so.
   *
   * `null` means nothing is known to be running — either the shell does not
   * emit OSC 133 at all, or it is sitting at a prompt. It is deliberately not
   * "the last time Enter was pressed": jterm sees Enter at every prompt,
   * including a REPL's, and only the shell can say which of those started a
   * command.
   */
  const runningSinceRef = useRef<number | null>(null);
  const exitedRef = useRef(false);
  /**
   * Set while a recorded log is being parsed back into the terminal.
   *
   * Everything xterm.js sends *up* the pty arrives through one callback,
   * whether the user typed it or the emulator generated it in answer to a
   * question. During a replay every one of those is an answer to a question
   * asked by a program that no longer exists — see `lib/scrollback.ts` — so
   * none of it is the user talking and none of it may reach the shell. Held as
   * a depth rather than a flag because a replay is written in more than one
   * piece and the guard has to span all of them.
   */
  const restoringRef = useRef(0);
  const replayRef = useRef<{
    text: string;
    /** Press Enter after it: a command the user chose to run, never a draft. */
    submit: boolean;
    settle: number;
    deadline: number;
  } | null>(null);
  /**
   * Set while a shell is being ended on purpose, to be started again inside
   * tmux. Its exit is not a death to announce — see `moveToTmux`.
   */
  const onExitRef = useRef<(() => void) | null>(null);
  /** Where the shell was when the last command was submitted, for the log. */
  const cwdRef = useRef<string | undefined>(pane.cwd);
  /** Coalesces draft records; every keystroke would be a line per character. */
  const draftLogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The tmux session behind this pane, or `undefined` for a bare shell.
   *
   * Held in a ref rather than read from `pane` because it has to survive the
   * shell exiting and being restarted with Enter — that new shell belongs in
   * the same session as the old one.
   */
  const sessionRef = useRef<string | undefined>(pane.tmux);
  /** A tmux the *user* started in an ordinary pane, seen by the poll below. */
  const inTmuxRef = useRef(false);

  /**
   * Whether anything tmux is between this pane and its shell, either way round.
   *
   * The one question the draft machinery asks. What it is really asking is
   * "would writing this down be a second copy of something already kept?", and
   * both kinds of tmux answer yes.
   */
  const underTmux = useCallback(
    () => sessionRef.current !== undefined || inTmuxRef.current,
    [],
  );

  // Read once: the pane's id and its restored state are fixed for the lifetime
  // of this component, and the effect below must not re-run when a title or a
  // directory changes underneath it.
  const paneId = pane.id;
  const initialRef = useRef({
    cwd: pane.cwd,
    draft: getContent(paneId).draft ?? "",
    // Whether the pane has a past worth offering back, read at mount so it is
    // the pane as it was restored rather than as it has become since.
    past: pane.agent !== undefined || pane.command !== undefined,
    tmux: pane.tmux,
    /** Set when tmux owns this pane outright — see `lib/tmuxControl.ts`. */
    control: pane.tmuxPane !== undefined,
  });
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;
  /** This pane's own type size, if it has been zoomed; else the setting's. */
  const fontSizeRef = useRef(pane.fontSize);
  fontSizeRef.current = pane.fontSize;
  /** `applySettings` from the effect below, for the changes that are not
   *  settings changes but have to do everything one does: a zoom, and a theme
   *  chosen for this pane or its tab. */
  const applySettingsRef = useRef<(() => void) | null>(null);

  /** Start (or restart) the shell and wire the terminal to it. */
  const spawn = useCallback(async (cwd: string | undefined) => {
    const term = termRef.current;
    if (!term) return;

    // A control-mode pane is already running. There is no pty to open: the pane
    // exists inside tmux, its bytes arrive on the session's one control client,
    // and spawning here would put a second shell behind a pane that has one.
    if (initialRef.current.control) {
      exitedRef.current = false;
      return;
    }

    exitedRef.current = false;
    await ptyBusReady();
    const info = await pty.spawn({
      id: paneId,
      cols: term.cols,
      rows: term.rows,
      ...pixelGeometry(hostRef.current),
      cwd,
      // Read at spawn rather than held, so changing it in Settings applies to
      // the next shell started — including the one Enter starts in a pane
      // whose shell has exited — and leaves running shells alone.
      shell: getSettings().shell || undefined,
      tmux: sessionRef.current,
    });
    if (info) {
      cwdRef.current = info.cwd;
      // Taken from the answer rather than from what was asked for: a session
      // requested on a machine without tmux comes back as a bare shell, and a
      // pane that went on believing otherwise would stop recording a history
      // nothing else is keeping.
      sessionRef.current = info.tmux ?? undefined;
      metaRef.current({ cwd: info.cwd, exited: false, tmux: info.tmux ?? undefined });
      void history.append(paneId, {
        kind: "spawn",
        at: new Date().toISOString(),
        shell: info.shell,
        cwd: info.cwd,
        pid: info.pid,
        tmux: info.tmux ?? undefined,
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
    void pty.write(paneId, pending.submit ? `${bytes}\r` : bytes);
    // The shell owns the line now, and its echo is the record of it; the mirror
    // is reset to match what was actually sent.
    draftRef.current = pending.submit ? emptyDraft() : draftFrom(pending.text);
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
    (text: string, submit = false) => {
      if (!text || !replayBytes(text)) return;
      replayRef.current = {
        text,
        submit,
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

  /**
   * Read the shell's real working directory and report it if it moved — and,
   * on the same trip, find out whether tmux is in front of it.
   *
   * The second question is asked here rather than on a timer of its own because
   * it is about the same process, changes on the same sort of timescale, and
   * the backend has to take the pid out from under the same lock either way.
   */
  const checkCwd = useCallback(() => {
    if (exitedRef.current) return;
    void pty.probe(paneId).then((probe) => {
      inTmuxRef.current = probe.tmux;
      const cwd = probe.cwd;
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

    /**
     * `Mod`+click on a URL, sent to the real browser.
     *
     * Used twice, for the two kinds of link a terminal has: the ones found by
     * scanning the text (`WebLinksAddon`) and the ones a program declares with
     * OSC 8 (`linkHandler`). Both have to be given a handler — xterm's own
     * default for either is `window.open`, which inside the Tauri webview is
     * at best nothing and, for OSC 8, a blocking `confirm()` first. See
     * `lib/links` for why a modifier is required and why the scheme is
     * checked.
     */
    const followLink = (event: MouseEvent, uri: string) => {
      if (!isLinkActivation(event)) return;
      const target = linkTarget(uri);
      if (target !== null) void openExternal(target);
    };

    const term = new Terminal({
      allowProposedApi: true,
      // Always, rather than only for the themes that need it. A theme whose
      // background has no alpha renders identically either way, and the option
      // is fixed at construction — leaving it off would mean a living theme
      // could not be chosen without rebuilding every terminal on screen.
      allowTransparency: true,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      // Read from the variable rather than from the setting: `lib/appearance`
      // is where a chosen family gets the built-in stack put behind it, and the
      // terminal should be looking at the same resolved value as the chrome.
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim(),
      fontSize: fontSizeRef.current ?? settings.fontSize,
      lineHeight: settings.lineHeight,
      // xterm keeps its own scrollback for the live session; the file on disk
      // is what survives a restart, and is capped separately.
      scrollback: settings.scrollback,
      theme: readTheme(host),
      // Left at its default `false`, so an OSC 8 link claiming any scheme but
      // http(s) never even reaches the handler.
      linkHandler: { activate: followLink },
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
    term.loadAddon(new WebLinksAddon(followLink));
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    /**
     * Pictures in the terminal: SIXEL, and iTerm's inline image protocol.
     *
     * This is not only about being able to `img2sixel` a photo. Programs ask
     * whether the terminal can show an image before they offer anything that
     * needs one — Codex's pets, `chafa`, `timg`, matplotlib's sixel backend,
     * fzf previews — and the question is asked as a *terminal query*: primary
     * device attributes (`CSI c`), whose answer must list `4` for sixel, and
     * the `CSI 14/16/18 t` size reports that say how many pixels a cell is.
     * A terminal that renders images but never says so is, to all of them,
     * a terminal without images. The addon answers both, which is most of why
     * it is here rather than a hand-rolled sixel decoder.
     *
     * `storageLimit` is well below the addon's own default of 128 MB, because
     * that default is written for a page with one terminal on it and jterm can
     * have a dozen panes alive at once. Images are held as unpacked RGBA, so
     * the cap is reached faster than the on-screen area suggests; past it the
     * oldest image in the scrollback is dropped, which is the right thing to
     * lose. 64 MB still holds a full screen of picture several times over.
     */
    term.loadAddon(new ImageAddon({ storageLimit: 64 }));

    const serializer = new SerializeAddon();
    term.loadAddon(serializer);

    /**
     * Write down what the terminal is showing, at most every `SCREEN_SAVE_MS`.
     *
     * The alternate screen is left out: `vim` or `less` is not something a
     * restore can bring back, and the reset after a replay leaves the alternate
     * screen anyway, so what would come back is the shell that was under it.
     * Modes are left out for the reason `lib/scrollback.ts` gives — a mode is a
     * program's arrangement with a terminal, and that program will be gone.
     *
     * Control-mode panes are skipped: tmux owns them and they are not in the
     * snapshot to be restored.
     */
    let screenTimer = 0;
    const saveScreen = () => {
      screenTimer = 0;
      const text = serializer.serialize({
        scrollback: SCREEN_ROWS,
        excludeAltBuffer: true,
        excludeModes: true,
      });
      void scrollbackApi.saveScreen(paneId, text);
    };
    const scheduleScreen = () => {
      if (screenTimer !== 0 || initialRef.current.control) return;
      screenTimer = window.setTimeout(saveScreen, SCREEN_SAVE_MS);
    };

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
     *
     * Most settings have nothing to do with a terminal — the file tree's
     * dotfiles switch is one — but every terminal hears about every change, and
     * handing xterm the same values again is not free: a new theme object
     * repaints every row, and the fit measures the page. Across a window of
     * split panes that held a click in the sidebar up for half a second. So a
     * change that moves nothing a terminal is drawn with stops here, after a
     * handful of style reads that the panes share between them.
     */
    let applied = JSON.stringify(appearanceOptions(host, fontSizeRef.current));
    const applySettings = () => {
      const next = appearanceOptions(host, fontSizeRef.current);
      const key = JSON.stringify(next);
      if (key === applied) return;
      applied = key;
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      term.options.lineHeight = next.lineHeight;
      term.options.cursorStyle = next.cursorStyle;
      term.options.cursorBlink = next.cursorBlink;
      term.options.scrollback = next.scrollback;
      term.options.theme = next.theme;
      safeFit();
      repaint();
      if (!exitedRef.current) void pty.resize(paneId, term.cols, term.rows, pixelGeometry(host));
    };
    const stopSettings = subscribeSettings(applySettings);
    applySettingsRef.current = applySettings;

    // Keystrokes on their way to the shell, mirrored on the way past.
    const dataSub = term.onData((data) => {
      // Not a keystroke: the emulator answering a question out of a replayed
      // log. Dropped rather than forwarded — it would be typed at the shell,
      // and it would cancel the draft replay below as if the user had.
      if (restoringRef.current > 0) return;
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
      // The mirror runs either way — the command log below is made out of it —
      // but under tmux it is not written down. What the snapshot holds is what
      // gets typed back on restore, and typing a line back at a shell that
      // never lost it would leave the user with it twice.
      if (!underTmux()) updateContent(paneId, { draft: draftRef.current.text });

      if (submitting && submitted.trim()) {
        // Whatever the pane was offering to bring back, it has moved on.
        suggestionsRef.current.noteCommand();
        // What the pane is now for, as far as anything can tell: its icon
        // follows this, and so does the offer to pick the session back up if
        // the machine goes down while it is running. See `lib/programs`.
        metaRef.current({ command: submitted.trim() } as Partial<TerminalPaneState>);
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
      // file a complete record rather than only a list of what ran — and it is
      // the one part of that record tmux makes redundant, since the line is
      // still sitting in a readline that is still running.
      if (underTmux()) return;
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
      if (restoringRef.current > 0) return;
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
        scheduleScreen();

        const scan = scanOsc(chunk, oscCarryRef.current);
        oscCarryRef.current = scan.carry;

        // What the shell says about its own prompts, where it says anything.
        // See `lib/osc.ts`: this is the only source of a real exit status, and
        // panes whose shell is quiet simply never take this branch.
        for (const mark of scan.marks) {
          if (mark.kind === "running") {
            runningSinceRef.current = Date.now();
          } else if (mark.kind === "done") {
            const started = runningSinceRef.current;
            runningSinceRef.current = null;
            void history.append(paneId, {
              kind: "result",
              at: new Date().toISOString(),
              // Both are absent rather than guessed when unknown. A missing
              // status is not zero, and a duration invented from when jterm
              // happened to notice would be a number that reads as measured.
              ...(mark.code === undefined ? {} : { code: mark.code }),
              ...(started === null ? {} : { ms: Date.now() - started }),
            });
          }
        }
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
        // Ended on purpose, to be started again in tmux: nothing to announce,
        // and the pane is not dead — its next shell is already on the way.
        const moving = onExitRef.current;
        if (moving !== null) {
          onExitRef.current = null;
          moving();
          return;
        }
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
      readText: (lines) => tailText(term.buffer.active, lines),
    });

    // Sizing follows the pane, and the shell follows the sizing.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        safeFit();
        repaint();
        if (!exitedRef.current)
          void pty.resize(paneId, term.cols, term.rows, pixelGeometry(host));
      });
    });
    observer.observe(host);

    let disposed = false;
    void (async () => {
      // Settled before anything is restored, because the answer changes what
      // restoring means. A pane already carrying a session name keeps it — that
      // is a restore, and the session is the thing being restored to. A new one
      // takes the setting's word for it and gets a session of its own.
      // Control mode settles it without asking: tmux owns the pane, so every
      // question below about restoring one is already answered.
      const wanted = initialRef.current.control
        ? initialRef.current.tmux
        : (initialRef.current.tmux ??
          (getSettings().shellBackend === "tmux" ? sessionNameFor(paneId) : undefined));
      sessionRef.current =
        wanted !== undefined && (initialRef.current.control || (await tmuxAvailable()))
          ? wanted
          : undefined;
      if (disposed) return;

      /**
       * Whether the tmux session behind this pane is *already running*.
       *
       * `new-session -A` attaches or creates and never says which, and the
       * difference is the whole of what restoring means here. A session that
       * survived redraws the screen itself and still holds the half-typed line,
       * so jterm must stay out of the way. A session that died with the machine
       * is a brand-new empty one wearing the same name — and that pane deserves
       * everything a plain shell would get back: its scrollback, and the
       * command it was in the middle of.
       *
       * False for a pane that is not tmux-backed at all, and for a brand-new
       * pane, where both of those come to nothing anyway.
       */
      const sessionAlive =
        sessionRef.current !== undefined && (await tmuxApi.hasSession(sessionRef.current));
      if (disposed) return;

      // Asked before anything is drawn, because the answer changes what the
      // pane does next. A mount is not always a new pane: the webview reloads
      // after WebKit's renderer dies (see `recover.rs`), and every pane in the
      // window remounts against a shell that never stopped running. Spawning
      // into one of those would kill it — `pty_spawn` closes a live id first,
      // by design — so a shell that is still there is adopted instead.
      //
      // The bus comes first, for a sharper reason than on the spawn path.
      // There the listener has to exist before the shell's first output, which
      // is the prompt. Here the shell is already running and already talking,
      // so a listener attached late misses whatever arrived in the meantime —
      // and if nothing calls `ready()` at all, as nothing on this path used to,
      // the pane reconnects to a live shell and then draws none of it. `spawn`
      // awaits this too; adopting has to do it itself.
      await ptyBusReady();
      const adopted = await pty.attach(paneId, term.cols, term.rows, pixelGeometry(host));
      if (disposed) return;

      // Neither of these is right in front of a *live* tmux session. The log
      // would paint a picture of the session that tmux is about to redraw
      // properly, and the draft belongs to a shell that still has it. A session
      // that is gone leaves nothing to argue with, so the pane is restored the
      // way a plain shell's would be.
      if (!sessionAlive) {
        // Scrollback first, so the shell's new prompt lands underneath the
        // output it is continuing from rather than on top of it. On an adopt
        // this is also the only copy of what the shell printed while there was
        // no webview to print it to: the reader thread kept recording
        // throughout, which is the whole reason that is not simply lost — so an
        // adopt reads the log.
        //
        // A shell that did not survive is drawn from the saved screen instead,
        // where there is a fresh one. The log is a program's drawing
        // instructions, and anything that redraws in place — every agent CLI —
        // replays from them as a pile of misplaced fragments. See `save_screen`
        // in `store.rs`.
        const previous = await (adopted ? scrollbackApi.read(paneId) : scrollbackApi.restore(paneId));
        if (disposed) return;
        if (previous) {
          // Guarded across both writes, and released by the second one's
          // callback: xterm.js parses what it is given in the order it was
          // given, so by the time that runs every answer the log provoked has
          // already been raised and dropped. The reset in the banner is the
          // other half of the same problem — the modes the log switched on,
          // put back the way a terminal starts. See `lib/scrollback.ts`.
          restoringRef.current += 1;
          term.write(previous);
          term.write(restoreBanner(Boolean(adopted)), () => {
            restoringRef.current -= 1;
          });
        }
      }

      if (adopted) {
        // The same bookkeeping `spawn` does on the way back, minus the history
        // entry: nothing started, so there is no spawn to record.
        exitedRef.current = false;
        cwdRef.current = adopted.cwd;
        sessionRef.current = adopted.tmux ?? undefined;
        metaRef.current({
          cwd: adopted.cwd,
          exited: false,
          tmux: adopted.tmux ?? undefined,
        });
      } else {
        await spawn(initialRef.current.cwd);
      }
      if (disposed) return;

      // A control-mode pane has a screenful of history already, and no way to
      // have heard about it before now: the layout that created this component
      // is the same message that would have carried it. Asked for here, with
      // the subscription above already in place.
      if (initialRef.current.control) tmuxControlApi.capture(paneId);
      // Not after an adopt, for the reason tmux is excluded just above: the
      // draft is a record of what the user had typed but not sent, and a shell
      // that is still running still has it sitting in its line editor —
      // echoed, so it is in the scrollback written out above too. Replaying it
      // would type the half-finished command a second time.
      if (!adopted && !sessionAlive) {
        // The half-typed line, if there was one. Only reached when the shell
        // did *not* survive — no pty to adopt and no tmux session still
        // standing.
        armReplay(initialRef.current.draft);
        // Which is also exactly when "what was I doing" is worth answering.
        // That used to be answered by typing the last session's command at the
        // prompt; it is offered as buttons now, which can say which
        // conversation they mean and what they will run. See
        // `usePaneSuggestions`.
        if (initialRef.current.past) suggestionsRef.current.markRestored();
      }
      // The prompt lands shortly after this; a repaint once the pane has
      // settled is what makes a restored session look restored rather than
      // empty.
      window.setTimeout(repaint, 250);
    })();

    return () => {
      disposed = true;
      window.clearTimeout(screenTimer);
      cancelReplay();
      stopSettings();
      applySettingsRef.current = null;
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
  }, [paneId, armReplay, bumpReplay, cancelReplay, checkCwd, spawn, underTmux]);

  // Focus follows the app's idea of the focused pane, not the DOM's, so
  // clicking a tab returns the caret to wherever it was in that tab.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  /**
   * Hand xterm the palette again when this pane's theme changes.
   *
   * A change of *settings* already comes through `applySettings`, but a theme
   * chosen for this pane or its tab is workspace state and never touches the
   * settings store. What both paths have in common is that the tokens have
   * already moved on the DOM by the time this runs — `Workspace` writes them in
   * the same commit — so re-reading is all there is to do.
   *
   * Through `applySettings` rather than beside it, so that its record of what
   * xterm was last given stays true. A palette set behind its back would leave
   * that record stale, and a later change could be skipped as already applied.
   */
  useEffect(() => {
    applySettingsRef.current?.();
  }, [theme]);

  /**
   * Zoom this pane's text.
   *
   * Everything `applySettings` does and for the same reason — a new size is a
   * new column count, and the shell has to hear about it. Skipped until the
   * size actually moves, because at mount the terminal was already built at it
   * and a resize before the shell exists is a message to nobody.
   */
  const appliedFontSizeRef = useRef(pane.fontSize);
  useEffect(() => {
    if (appliedFontSizeRef.current === pane.fontSize) return;
    appliedFontSizeRef.current = pane.fontSize;
    applySettingsRef.current?.();
  }, [pane.fontSize]);

  /**
   * Start this pane's shell again, inside a tmux session of its own.
   *
   * Only ever offered for a shell sitting at its prompt, because it ends that
   * shell: a process cannot be moved into tmux, only started there. The old one
   * is ended and its exit waited for before the new one starts — see
   * `MOVE_EXIT_WAIT_MS` for why the order matters. If the wait runs out, the
   * exit is still expected, and still swallowed when it comes.
   */
  const moveToTmux = useCallback(async (): Promise<boolean> => {
    const term = termRef.current;
    if (term === null || initialRef.current.control || sessionRef.current !== undefined) {
      return false;
    }
    if (!(await tmuxAvailable())) return false;
    cancelReplay();
    if (!exitedRef.current) {
      const exited = new Promise<void>((resolve) => {
        onExitRef.current = resolve;
      });
      void pty.kill(paneId);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => window.setTimeout(resolve, MOVE_EXIT_WAIT_MS)),
      ]);
    }
    sessionRef.current = sessionNameFor(paneId);
    term.write("\r\n\x1b[2m── moved to tmux ──\x1b[0m\r\n");
    await spawn(cwdRef.current);
    // `spawn` takes the backend's word for whether tmux was actually used.
    return sessionRef.current !== undefined;
  }, [paneId, spawn, cancelReplay]);

  /** What a suggestion's buttons are allowed to do to the shell. */
  const controlsRef = useRef<ShellControls | null>(null);
  controlsRef.current = {
    send: (command, submit) => {
      const line = replayBytes(command);
      if (exitedRef.current || !line) return;
      cancelReplay();
      // ^U first, so whatever is on the line — a restored draft, most likely —
      // is replaced rather than joined. Readline keeps it for ^Y.
      void pty.write(paneId, `\x15${line}${submit ? "\r" : ""}`);
      draftRef.current = submit ? emptyDraft() : draftFrom(command);
      if (!underTmux()) updateContent(paneId, { draft: draftRef.current.text });
      if (submit) metaRef.current({ command } as Partial<TerminalPaneState>);
    },
    sendWhenReady: (command) => armReplay(command, true),
    moveToTmux,
    onTmux: () => sessionRef.current !== undefined,
    focus: () => termRef.current?.focus(),
  };

  const offers = usePaneSuggestions(pane, controlsRef, onMeta);
  // Read from the mount effect and the key handler, neither of which should
  // re-run because what is on offer changed.
  const suggestionsRef = useRef(offers);
  suggestionsRef.current = offers;

  return (
    // The cards sit beside the terminal's host, not inside it: xterm owns every
    // child of the element it is opened in.
    <div className="relative h-full w-full">
      <div
        className="pane-ground h-full w-full overflow-hidden px-1.5 pt-1"
        onMouseDown={onFocus}
        ref={hostRef}
      />
      <SuggestionCards
        suggestions={offers.suggestions}
        onAction={offers.act}
        onDismiss={offers.dismiss}
      />
    </div>
  );
}

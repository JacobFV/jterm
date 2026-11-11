/**
 * A document the agent made for the user to look at — see `lib/artifacts.ts`.
 *
 * The source is read from the content store, not from the pane's state, and the
 * pane subscribes to it: when the agent rewrites an artifact the store changes
 * and this redraws in place, with no new pane and no message through React
 * state for every other pane to re-render over.
 *
 * Each format is drawn by whatever already draws it best:
 *
 *   - **Markdown** goes through `MarkdownPreview`, which sanitises it and draws
 *     it in the pane's own DOM and theme.
 *   - **Mermaid** goes through `lib/mermaid`, in the pane's colours, in strict
 *     mode — its SVG is inserted as markup, so that setting is load bearing.
 *   - **HTML and SVG** go into an `<iframe srcdoc>`, and that frame is where
 *     the care is. Both can carry script, which is often the point (a chart, a
 *     page that sorts its own table), and this window is a Tauri webview with
 *     the IPC bridge in it. So the frame is `sandbox="allow-scripts"` and
 *     nothing else:
 *
 *       - No `allow-same-origin`, so the page runs in an opaque origin. It
 *         cannot reach `parent` beyond `postMessage`, cannot read the app's
 *         storage, and its requests carry `Origin: null` — which is also what
 *         the MCP server refuses. Scripts plus same-origin is the one
 *         combination that lets a frame lift its own sandbox, and it is never
 *         to be added here.
 *       - No IPC: Tauri injects its bridge into the main frame only, and an
 *         opaque-origin frame matches no capability even if it tried.
 *       - No `allow-top-navigation` or `allow-popups`, so it cannot navigate
 *         the window away or open new ones. Links come up as messages instead
 *         (`LINK_SCRIPT`) and go to the user's browser.
 *       - No `allow-forms` or `allow-modals`: a document has no business
 *         submitting anywhere or stopping the app with an `alert`.
 *
 *     The app runs with no CSP (`tauri.conf.json` has `"csp": null`), so
 *     there is no policy to loosen for `srcdoc`. Nor is one added inside the
 *     frame: network access is what lets a page pull a chart library from a
 *     CDN, and the agent writing it can already reach the network from its
 *     own shell — it gains nothing by doing so from here.
 *
 * The header is deliberately slim: what it is, the source, and the three
 * things someone does with a document they were handed — copy it, keep it,
 * and look again.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Check, Code, Copy, Eye, RotateCw, Save } from "lucide-react";

import {
  FORMAT_LABEL,
  frameDocument,
  isDarkColour,
  LINK_MESSAGE,
  suggestedFileName,
  type FramePalette,
} from "@/lib/artifacts";
import { writeClipboard } from "@/lib/clipboard";
import { dialog, files, openExternal } from "@/lib/ipc";
import { linkTarget } from "@/lib/links";
import { cn } from "@/lib/utils";
import { getContent, onContentChange } from "@/state/content";
import type { ArtifactPaneState } from "@/state/workspace";
import { MarkdownPreview } from "./MarkdownPreview";
import type { PaneProps } from "./types";

/** The sandbox, whole. See the header for why each thing is missing. */
const SANDBOX = "allow-scripts";

/**
 * How long after one link is opened before another is believed.
 *
 * The message a frame sends up can be sent by the page's own script as easily
 * as by a click. The pane only listens while the user is in the frame, and this
 * stops a page that wanted to from opening a browser tab per millisecond.
 */
const LINK_COOLDOWN_MS = 1000;

/** How long "Copied" and "Saved" stay up. */
const NOTICE_MS = 1800;

export function ArtifactPane({ pane, focused, theme, onFocus }: PaneProps<ArtifactPaneState>) {
  const source = useArtifactSource(pane.id);
  const [showSource, setShowSource] = useState(false);
  /** Bumped by Reload; used as a key, so the view is built again from nothing. */
  const [reloads, setReloads] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const label = pane.name ?? pane.title ?? "Artifact";

  useEffect(() => {
    if (notice === null || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const copy = useCallback(async () => {
    try {
      await writeClipboard(source);
      setNotice({ text: "Copied" });
    } catch (cause) {
      setNotice({ text: String(cause), error: true });
    }
  }, [source]);

  // Saving writes a copy. The artifact stays an artifact — it does not become
  // the file, and a later update from the agent does not touch what was saved.
  const save = useCallback(async () => {
    const target = await dialog.save(suggestedFileName(pane.title, pane.format));
    if (!target) return;
    try {
      await files.writeText(target, source);
      setNotice({ text: "Saved" });
    } catch (cause) {
      setNotice({ text: String(cause), error: true });
    }
  }, [pane.title, pane.format, source]);

  // Ctrl/Cmd+S as in a notepad, while this pane has the keyboard.
  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused, save]);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2">
        <span className="min-w-0 flex-1 truncate text-[length:var(--fs-11)] text-ink-2">{label}</span>
        <span className="shrink-0 font-mono text-[length:var(--fs-9)] uppercase tracking-[0.14em] text-ink-3">
          {FORMAT_LABEL[pane.format]}
        </span>
        {notice ? (
          <span
            className={cn(
              "max-w-[40%] shrink truncate font-mono text-[length:var(--fs-10)]",
              notice.error ? "text-danger" : "text-ink-3",
            )}
            title={notice.text}
          >
            {notice.text}
          </span>
        ) : null}
        <HeaderButton
          label={showSource ? "Show it rendered" : "Show the source"}
          pressed={showSource}
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? <Eye className="h-3 w-3" /> : <Code className="h-3 w-3" />}
          {showSource ? "Rendered" : "Source"}
        </HeaderButton>
        <HeaderButton label="Copy the source" onClick={() => void copy()}>
          {notice?.text === "Copied" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </HeaderButton>
        <HeaderButton label="Save a copy to a file…" onClick={() => void save()}>
          <Save className="h-3 w-3" />
        </HeaderButton>
        <HeaderButton label="Reload" onClick={() => setReloads((value) => value + 1)}>
          <RotateCw className="h-3 w-3" />
        </HeaderButton>
      </div>

      {source === "" ? (
        <p className="p-4 text-[length:var(--fs-11)] text-ink-3">This artifact is empty.</p>
      ) : showSource ? (
        <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[length:var(--fs-11)] text-ink-1">
          {source}
        </pre>
      ) : pane.format === "markdown" ? (
        <MarkdownPreview key={reloads} text={source} />
      ) : pane.format === "mermaid" ? (
        <MermaidView key={reloads} source={source} theme={theme} />
      ) : (
        <ArtifactFrame
          key={reloads}
          format={pane.format}
          source={source}
          title={label}
          theme={theme}
          onFocus={onFocus}
        />
      )}
    </div>
  );
}

/**
 * The artifact's source, kept current.
 *
 * Every change to the content store calls back here — a keystroke at any
 * prompt included — but what comes back is a string compared by value, so
 * React re-renders this pane only when its own source actually changed.
 */
function useArtifactSource(paneId: string): string {
  const subscribe = useCallback((listener: () => void) => {
    const stop = onContentChange(listener);
    return () => {
      stop();
    };
  }, []);
  return useSyncExternalStore(subscribe, () => getContent(paneId).text ?? "");
}

/* ── HTML and SVG ────────────────────────────────────────────────────────── */

function ArtifactFrame({
  format,
  source,
  title,
  theme,
  onFocus,
}: {
  format: "html" | "svg";
  source: string;
  title: string;
  theme: PaneProps["theme"];
  onFocus: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [palette, setPalette] = useState<FramePalette | null>(null);
  const lastLink = useRef(0);
  // Built once per change rather than per render: the source can be a
  // megabyte, and the header re-renders for every "Copied".
  const framed = useMemo(
    () => (palette === null ? null : frameDocument(format, source, palette)),
    [format, source, palette],
  );

  // The theme's colours, as values. Read off a probe in the pane, after the
  // pane's tokens have been applied, and again whenever the theme changes —
  // which rebuilds the frame, as a new `srcdoc` does.
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (probe === null) return;
    const read = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const background = read("--term-bg-solid");
    setPalette({
      background,
      foreground: read("--term-fg"),
      link: read("--term-blue"),
      dark: isDarkColour(background),
    });
  }, [theme]);

  // A click inside the frame goes to the frame's document, not to this one, so
  // the pane never sees a mousedown to take focus with. What this window does
  // see is itself losing focus to the frame.
  useEffect(() => {
    const onBlur = () => {
      window.setTimeout(() => {
        if (document.activeElement === frameRef.current) onFocus();
      }, 0);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [onFocus]);

  // Links clicked in the frame, sent up by `LINK_SCRIPT`. Only this frame's
  // messages, only while the user is in it, only http(s) as `linkTarget` reads
  // it, and not faster than a person clicks.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const href = (data as Record<string, unknown>)[LINK_MESSAGE];
      if (typeof href !== "string") return;
      if (document.activeElement !== frame) return;
      const now = Date.now();
      if (now - lastLink.current < LINK_COOLDOWN_MS) return;
      const target = linkTarget(href);
      if (target === null) return;
      lastLink.current = now;
      void openExternal(target);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <span ref={probeRef} aria-hidden className="pointer-events-none absolute h-0 w-0 opacity-0" />
      {palette !== null && framed !== null ? (
        <iframe
          ref={frameRef}
          title={title}
          sandbox={SANDBOX}
          srcDoc={framed}
          referrerPolicy="no-referrer"
          className="h-full w-full border-0"
          // The frame's own background until its document paints, so loading
          // one is not a white flash in a dark theme.
          style={{ background: palette.background, colorScheme: palette.dark ? "dark" : "light" }}
        />
      ) : null}
    </div>
  );
}

/* ── Mermaid ─────────────────────────────────────────────────────────────── */

/**
 * One diagram, drawn the way a diagram in a markdown document is.
 *
 * Generation-guarded for the same reason `MarkdownPreview` is: mermaid is
 * imported and renders asynchronously, and an update that lands while an older
 * render is still resolving must not have the older one drawn over it.
 */
function MermaidView({ source, theme }: { source: string; theme: PaneProps["theme"] }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const mine = ++generation.current;
    const block = document.createElement("pre");
    block.textContent = source;
    host.replaceChildren(block);
    void (async () => {
      const { renderMermaid } = await import("@/lib/mermaid");
      if (generation.current !== mine) return;
      await renderMermaid(host, [block]);
    })();
    // The theme is a dependency on purpose: the diagram's colours are read off
    // the pane when it is drawn, so a new theme needs a new drawing.
  }, [source, theme]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div ref={hostRef} className="markdown flex min-h-full items-center justify-center px-4 py-3" />
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-hairline-strong px-1.5 text-[length:var(--fs-10)] text-ink-2 hover:bg-surface-2 hover:text-ink-1"
    >
      {children}
    </button>
  );
}

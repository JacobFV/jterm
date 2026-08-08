/**
 * A web pane.
 *
 * ── Why this is an iframe ────────────────────────────────────────────────
 * The better implementation is a real child webview: Tauri can add a second
 * webview to a window and position it over a pane, which gives a genuine
 * browser with no framing restrictions. That was built first, and then removed,
 * because it does not work on Linux. Tauri's GTK backend only ever puts
 * webviews in a `GtkBox` (`tauri-runtime-wry` has no `GtkFixed` anywhere), and
 * wry's `set_bounds` is a no-op unless the webview is in a fixed parent or owns
 * an X11 child window — neither of which happens on that path. The webview is
 * created and loads the page, and then cannot be placed anywhere. Shipping a
 * feature that works on two of three platforms, when the third is the one being
 * developed on, is worse than shipping one that works everywhere.
 *
 * So: an iframe, and honesty about what an iframe cannot do.
 *
 *   - Sites that send `X-Frame-Options: DENY` or a restrictive
 *     `frame-ancestors` will refuse to appear. There is no way around that from
 *     inside the page, so the pane detects it and offers the one thing that
 *     always works: opening the URL in the user's real browser.
 *   - History is kept here rather than read from the frame. A cross-origin
 *     iframe's `history` is unreadable, so back and forward cover addresses
 *     entered in the bar, not links followed inside the page.
 *   - `sandbox` deliberately omits `allow-top-navigation`. Without that, a page
 *     in a pane could set `top.location` and navigate the whole application
 *     away — replacing the terminal with whatever it liked.
 *
 * What it is good at is the thing a browser next to a terminal is mostly for:
 * a dev server on localhost, and documentation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";

import { openExternal } from "@/lib/ipc";
import { displayHost, normalizeUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import type { BrowserPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

/**
 * How long a page has to load before the pane assumes it was refused.
 *
 * A frame blocked by `X-Frame-Options` does not report an error — in most
 * engines it simply never fires `load`. Silence is the only signal available,
 * so it is given a generous amount of time before being believed.
 */
const REFUSED_AFTER_MS = 6000;

/** Everything a pane is allowed to do inside its frame, and nothing more. */
const SANDBOX = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-downloads",
].join(" ");

export function BrowserPane({ pane, focused, onMeta, onFocus }: PaneProps<BrowserPaneState>) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;

  // Our own history, since the frame's is unreadable. `at` is the position
  // within it, so going back and then somewhere new truncates the future the
  // way a browser does.
  const [history, setHistory] = useState<string[]>([pane.url]);
  const [at, setAt] = useState(0);
  const url = history[at] ?? pane.url;

  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "refused">("loading");
  // Bumped to force a reload of the same URL, which changing `src` alone
  // would not do.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!editing) setAddress(url);
    metaRef.current({ url, title: displayHost(url) ?? undefined });
  }, [url, editing]);

  useEffect(() => {
    setStatus("loading");
    const timer = setTimeout(() => {
      setStatus((current) => (current === "loading" ? "refused" : current));
    }, REFUSED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [url, reloadToken]);

  const go = useCallback(
    (raw: string) => {
      const next = normalizeUrl(raw);
      setEditing(false);
      inputRef.current?.blur();
      if (next === url) {
        setReloadToken((token) => token + 1);
        return;
      }
      setHistory((previous) => [...previous.slice(0, at + 1), next]);
      setAt((position) => position + 1);
    },
    [at, url],
  );

  const canBack = at > 0;
  const canForward = at < history.length - 1;

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface-1 px-1.5">
        <NavButton label="Back" disabled={!canBack} onClick={() => setAt((p) => p - 1)}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </NavButton>
        <NavButton label="Forward" disabled={!canForward} onClick={() => setAt((p) => p + 1)}>
          <ArrowRight className="h-3.5 w-3.5" />
        </NavButton>
        <NavButton label="Reload" onClick={() => setReloadToken((token) => token + 1)}>
          <RotateCw className="h-3 w-3" />
        </NavButton>
        <input
          ref={inputRef}
          value={address}
          aria-label="Address"
          spellCheck={false}
          placeholder="Search, or type an address"
          onChange={(event) => {
            setEditing(true);
            setAddress(event.target.value);
          }}
          onFocus={(event) => {
            setEditing(true);
            event.target.select();
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") go(event.currentTarget.value);
            if (event.key === "Escape") {
              setAddress(url);
              inputRef.current?.blur();
            }
          }}
          className={cn(
            "min-w-0 flex-1 rounded-sm border border-transparent bg-surface-2 px-2 py-1 font-mono text-[length:var(--fs-11)] text-ink-2 outline-none",
            "focus:border-hairline-strong focus:text-ink-1",
            focused && "text-ink-1",
          )}
        />
        <NavButton label="Open in your browser" onClick={() => void openExternal(url)}>
          <ExternalLink className="h-3 w-3" />
        </NavButton>
      </div>

      <div className="relative min-h-0 flex-1">
        <iframe
          key={reloadToken}
          ref={frameRef}
          src={url}
          title={displayHost(url) ?? "Web page"}
          sandbox={SANDBOX}
          referrerPolicy="no-referrer-when-downgrade"
          onLoad={() => setStatus("ready")}
          className="h-full w-full border-0 bg-white"
        />

        {status === "refused" ? (
          <div className="absolute inset-x-0 bottom-0 border-t border-hairline-strong bg-surface-2 px-3 py-2">
            <p className="text-[length:var(--fs-11)] text-ink-2">
              {displayHost(url) ?? "This site"} did not load in a pane — many sites refuse
              to be embedded.{" "}
              <button
                type="button"
                onClick={() => void openExternal(url)}
                className="text-brand underline underline-offset-2"
              >
                Open it in your browser
              </button>
              .
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NavButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
        disabled ? "text-ink-4" : "text-ink-3 hover:bg-surface-2 hover:text-ink-1",
      )}
    >
      {children}
    </button>
  );
}

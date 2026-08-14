/**
 * Every command jterm has a record of, searchable.
 *
 * The data has been on disk since the first version — `terminals/<pane>.jsonl`
 * has recorded every submitted command with its directory and the time — and
 * until now the only thing that ever read it back was export. This is the
 * reader.
 *
 * It is deliberately not a replacement for the shell's own `Ctrl+R`, which is
 * per-shell and dies with it. This one spans every pane jterm still has a log
 * for, so it answers the question the shell's cannot: *that* line, in *that*
 * repo, some weeks ago, in a tab that is no longer the one you are looking at.
 *
 * **It is every line you submitted at a prompt, not only shell commands.** jterm
 * mirrors what you type and records it when you press Enter, and from out here
 * a shell's prompt and an interactive program's prompt are the same thing — so
 * what you typed into a REPL, a pager or an AI agent is in here beside your
 * `cargo build`s. That is honest to what is recorded, and useful more often
 * than not; telling the two apart needs the shell to say where its prompts
 * begin, which is what OSC 133 is for and is not something jterm can infer.
 *
 * **Choosing a command types it at the prompt. It does not run it.** That is
 * the same promise the restored draft line makes — jterm never submits anything
 * on your behalf — and it matters more here, because what comes back is a
 * command you half-remember from a directory you may not be in.
 *
 * The search runs in the backend (`history::search`), so what crosses the IPC
 * boundary is the twenty rows being shown rather than every log on disk.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";

import { history, type HistoryHit } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** Quiet period before a keystroke becomes a search. */
const DEBOUNCE_MS = 90;

/** `~/x` rather than `/home/you/x`, which is most of the width back. */
function shortenPath(path: string | null, home: string | null): string {
  if (path === null) return "";
  if (home !== null && home.length > 1 && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * "3 days ago", roughly.
 *
 * Roughly is the point: the useful question about a command in a history is
 * whether it was this morning or last month, and a timestamp to the second
 * makes that harder to see rather than easier.
 */
function when(at: string | null): string {
  if (at === null) return "";
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 90) return "just now";
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d ago`;
  const weeks = days / 7;
  if (weeks < 9) return `${Math.round(weeks)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function HistorySearch({
  home,
  onPick,
  onClose,
}: {
  /** The home directory, for shortening paths. `null` if it is not known. */
  home: string | null;
  /** Called with the command to type at the focused prompt — never submitted. */
  onPick: (command: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HistoryHit[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Debounced, and the empty query is a real search rather than an empty
  // result: opening this with nothing typed should show what you ran last.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void history.search(query, 60).then((found) => {
        if (cancelled) return;
        setHits(found);
        setActive(0);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const choose = useCallback(
    (hit: HistoryHit | undefined) => {
      if (hit === undefined) return;
      onPick(hit.text);
      onClose();
    },
    [onPick, onClose],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    const rows = hits ?? [];
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => Math.min(rows.length - 1, index + 1));
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[active]);
    }
  };

  // Keep the highlighted row in view when the arrows walk past the edge.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      {/* A click anywhere else closes it, the same as Escape. */}
      <div className="absolute inset-0" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-label="Command history"
        className="relative flex max-h-[68vh] w-[620px] max-w-[92vw] flex-col border border-hairline-strong bg-surface-2 shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search everything you have typed at a prompt"
            aria-label="Search history"
            className="w-full bg-transparent font-mono text-[length:var(--fs-11)] text-ink-1 placeholder:text-ink-4 focus:outline-none"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {hits === null ? (
            <p className="px-3 py-2 text-[length:var(--fs-11)] text-ink-4">Looking…</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-[length:var(--fs-11)] text-ink-4">
              {query.trim() === ""
                ? "Nothing recorded yet. What you type from now on will show up here."
                : "Nothing you have typed matches all of those words."}
            </p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={`${hit.pane}:${hit.text}`}
                type="button"
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(hit)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left",
                  index === active ? "bg-surface-3" : "hover:bg-surface-3",
                )}
              >
                <span className="w-full truncate font-mono text-[length:var(--fs-11)] text-ink-1">
                  {hit.text}
                </span>
                <span className="flex w-full items-center gap-2 text-[length:var(--fs-10)] text-ink-4">
                  <span className="min-w-0 flex-1 truncate">{shortenPath(hit.cwd, home)}</span>
                  <span className="shrink-0">{when(hit.at)}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <p className="shrink-0 border-t border-border px-3 py-1.5 text-[length:var(--fs-10)] text-ink-4">
          Enter types it at the prompt without running it.
        </p>
      </div>
    </div>,
    document.body,
  );
}

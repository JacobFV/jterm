/**
 * The sidebar's Search tab: text across every file under the directory the
 * sidebar is following, and files whose names match.
 *
 * Searched as you type, after a pause. The directory is the one the focused
 * terminal is in, the same one the file tree shows, so `cd` into a project and
 * the search is of that project. Which files count, and why a search that is
 * overtaken gives up, is the backend's story — see `src-tauri/src/search.rs`.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CaseSensitive, ChevronDown, ChevronRight } from "lucide-react";

import { kindForPath } from "@/lib/filetypes";
import { search, type SearchResult } from "@/lib/ipc";
import { paneKind } from "@/panes/registry";
import { HeaderButton, SidebarHeader, SidebarNote, baseName, errorText } from "./SidebarChrome";

/** Long enough that a word is typed before it is searched for. */
const DEBOUNCE_MS = 220;

export function SidebarSearch({
  root,
  active,
  onOpen,
  switcher,
}: {
  root: string;
  /** On screen: the sidebar is open and this is its tab. */
  active: boolean;
  onOpen: (path: string) => void;
  switcher: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Which search is the latest, so an answer to an older one is dropped. */
  const latest = useRef(0);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const run = useCallback((text: string, matchCase: boolean, dir: string) => {
    const mine = (latest.current += 1);
    if (!text) {
      setResult(null);
      setBusy(false);
      setError(null);
      return;
    }
    setBusy(true);
    search.files(dir, text, matchCase).then(
      (found) => {
        if (mine !== latest.current || found.superseded) return;
        setResult(found);
        setFolded({});
        setError(null);
        setBusy(false);
      },
      (failure) => {
        if (mine !== latest.current) return;
        setError(errorText(failure));
        setBusy(false);
      },
    );
  }, []);

  // Also re-run when the directory moves: the results belong to a directory,
  // and a list from the one the shell just left would be answering the wrong
  // question. Not while hidden, though — a `cd` in a background tab is no
  // reason to walk a tree nobody is looking at.
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => run(query, caseSensitive, root), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, caseSensitive, root, active, run]);

  const hits = result?.files.reduce((sum, file) => sum + file.hits.length, 0) ?? 0;
  const summary = !query
    ? `in ${root}`
    : busy
      ? "searching…"
      : result
        ? `${hits} ${hits === 1 ? "match" : "matches"} in ${result.files.length} ${
            result.files.length === 1 ? "file" : "files"
          }${result.truncated ? " — stopped early, narrow the search" : ""}`
        : "";
  const join = (rel: string) => `${root.replace(/[\\/]+$/, "")}/${rel}`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <SidebarHeader switcher={switcher} title="Search" hint={root}>
        <HeaderButton
          label={caseSensitive ? "Match case: on" : "Match case: off"}
          active={caseSensitive}
          onClick={() => setCaseSensitive((on) => !on)}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
        </HeaderButton>
      </SidebarHeader>

      <div className="shrink-0 border-b border-border px-1.5 py-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
          placeholder={`Search ${baseName(root)}`}
          spellCheck={false}
          aria-label="Search text"
          className="w-full border border-border bg-surface-0 px-1.5 py-1 font-mono text-[length:var(--fs-11)] text-ink-1 outline-none placeholder:text-ink-4 focus:border-brand"
        />
        <p className="mt-1 truncate text-[length:var(--fs-10)] text-ink-4" title={summary}>
          {summary}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? <SidebarNote tone="danger">{error}</SidebarNote> : null}

        {result && result.names.length > 0 ? (
          <Group
            label={`Files named like this (${result.names.length})`}
            folded={folded[":names"] === true}
            onFold={() => setFolded((current) => ({ ...current, ":names": !current[":names"] }))}
          >
            {result.names.map((rel) => (
              <FileRow key={rel} rel={rel} onClick={() => onOpen(join(rel))} />
            ))}
          </Group>
        ) : null}

        {result?.files.map((file) => (
          <Group
            key={file.path}
            label={file.rel}
            count={file.hits.length}
            icon={paneKind(kindForPath(file.path)).icon}
            folded={folded[file.path] === true}
            onFold={() => setFolded((current) => ({ ...current, [file.path]: !current[file.path] }))}
          >
            {file.hits.map((hit, index) => (
              <button
                key={`${hit.line}:${index}`}
                type="button"
                onClick={() => onOpen(file.path)}
                title={`${file.rel}:${hit.line}`}
                className="flex w-full items-baseline gap-1.5 py-[2px] pl-6 pr-2 text-left hover:bg-surface-2"
              >
                <span className="shrink-0 font-mono text-[length:var(--fs-9)] text-ink-4">
                  {hit.line}
                </span>
                <span className="min-w-0 flex-1 truncate whitespace-pre font-mono text-[length:var(--fs-10)] text-ink-3">
                  {hit.before}
                  <mark
                    className="text-ink-1"
                    style={{ background: "hsl(var(--brand) / 0.28)" }}
                  >
                    {hit.matched}
                  </mark>
                  {hit.after}
                </span>
              </button>
            ))}
          </Group>
        ))}

        {result && !busy && query && hits === 0 && result.names.length === 0 ? (
          <SidebarNote>nothing found</SidebarNote>
        ) : null}
      </div>
    </div>
  );
}

function Group({
  label,
  count,
  icon: Icon,
  folded,
  onFold,
  children,
}: {
  label: string;
  count?: number;
  icon?: React.ComponentType<{ className?: string }>;
  folded: boolean;
  onFold: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onFold}
        title={label}
        className="flex w-full items-center gap-1 py-[3px] pl-1 pr-2 text-left hover:bg-surface-2"
      >
        {folded ? (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-4" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-4" />
        )}
        {Icon ? <Icon className="h-3 w-3 shrink-0 text-ink-4" /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-11)] text-ink-2">
          {label}
        </span>
        {count !== undefined ? (
          <span className="shrink-0 font-mono text-[length:var(--fs-9)] text-ink-4">{count}</span>
        ) : null}
      </button>
      {folded ? null : children}
    </div>
  );
}

function FileRow({ rel, onClick }: { rel: string; onClick: () => void }) {
  const Icon = paneKind(kindForPath(rel)).icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={rel}
      className="flex w-full items-center gap-1 py-[2px] pl-6 pr-2 text-left hover:bg-surface-2"
    >
      <Icon className="h-3 w-3 shrink-0 text-ink-4" />
      <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)] text-ink-3">
        {rel}
      </span>
    </button>
  );
}

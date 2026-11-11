/**
 * A git diff, read in a pane: the working tree's changes, what is staged, or
 * one commit — the whole repository's, or one file's.
 *
 * The pane holds a description of the comparison and nothing else (see
 * `DiffPaneState`); the text is read from git every time it might have moved.
 * For a commit that is only when the description changes or someone asks,
 * since a commit does not change. For the working tree and the index it is
 * also whenever the pane comes back into view or takes the keyboard, and when
 * the window does — the moments someone is about to look at it after doing
 * something elsewhere. It does not poll: a pane in a background tab re-reading
 * a large diff every few seconds is work nobody is looking at, and the
 * sidebar's Git tab already polls for the cheap question of *whether* anything
 * changed.
 *
 * Drawing is `DiffView`'s, which knows nothing about git. A pull-request pane
 * can hand it `gh pr diff` and get the same thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Columns2, GitCommitHorizontal, GitCompare, RotateCw, Rows2 } from "lucide-react";

import { DiffView } from "@/components/diff/DiffView";
import { baseName, errorText } from "@/components/shell/SidebarChrome";
import { parseDiff } from "@/lib/diff";
import { git, type GitDiffView } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { diffLabel, type DiffPaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

/**
 * `undefined` before the first answer; `null` when the directory is in no
 * repository, which is an answer rather than a failure.
 */
type Loaded = GitDiffView | null | undefined;

export function DiffPane({ pane, focused, visible, onMeta, onFocus }: PaneProps<DiffPaneState>) {
  const [view, setView] = useState<Loaded>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Responses can arrive out of order — a refresh clicked while the last read
  // is still running. Only the newest is allowed to land.
  const generation = useRef(0);
  const live = pane.source !== "commit";

  const { root, source, rev, path } = pane;
  const load = useCallback(async () => {
    if (!root) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await git.diffView({ cwd: root, source, rev, path });
      if (mine !== generation.current) return;
      // The same text is the same diff: keep the old object, so nothing is
      // parsed again and the view does not redraw — and does not lose the
      // place of someone halfway down it.
      setView((current) =>
        current && next && current.text === next.text && current.truncated === next.truncated
          ? current
          : next,
      );
      setError(null);
    } catch (failure) {
      if (mine !== generation.current) return;
      setError(errorText(failure));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [root, source, rev, path]);

  // A different comparison is a different pane's worth of content: start over.
  useEffect(() => {
    setView(undefined);
    setError(null);
    void load();
  }, [load]);

  // Back into view, or given the keyboard: the moments a working-tree diff may
  // have gone stale. Skipped on the first run, which the effect above covers.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    if (live && visible) void load();
    // `load` is deliberately not a dependency: a new comparison is the effect
    // above's business, and listing it would read the diff twice.
  }, [live, visible, focused]);

  // And when the window comes back from another app — an editor, say, which
  // is where the changes being looked at were probably made.
  useEffect(() => {
    if (!live || !visible) return;
    const onWindowFocus = () => void load();
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [live, visible, load]);

  const files = useMemo(() => (view ? parseDiff(view.text) : []), [view]);

  // A title worth having in a tab: a commit's subject, else what the label
  // already says plus how many files.
  const title = useMemo(() => {
    if (view?.commit) return `${view.commit.short} ${view.commit.subject}`.slice(0, 120);
    if (!view) return undefined;
    const label = diffLabel(pane);
    return files.length > 0 && !pane.path ? `${label} (${files.length})` : label;
  }, [view, files.length, pane]);
  useEffect(() => {
    if (title !== undefined && title !== pane.title) onMeta({ title });
  }, [title, pane.title, onMeta]);

  const split = pane.layout === "split";

  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2 text-[length:var(--fs-10)]">
        {source === "commit" ? (
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        ) : (
          <GitCompare className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        )}
        <span className="shrink-0 text-ink-2">{describe(pane, view)}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ink-4"
          title={path ? `${view?.root ?? root}/${path}` : (view?.root ?? root)}
        >
          {path ?? baseName(view?.root ?? root)}
        </span>
        {view?.truncated ? (
          <span
            className="shrink-0 text-warn"
            title="The diff is larger than a pane will read. What is shown stops part way."
          >
            cut short
          </span>
        ) : null}
        {view && view.untrackedOmitted > 0 ? (
          <span
            className="shrink-0 text-ink-3"
            title="Untracked files past the first few hundred are left out."
          >
            +{view.untrackedOmitted} untracked not shown
          </span>
        ) : null}
        <HeaderToggle
          title={split ? "Show the changes in one column" : "Show old and new side by side"}
          onClick={() => onMeta({ layout: split ? undefined : "split" })}
        >
          {split ? <Rows2 className="h-3 w-3" /> : <Columns2 className="h-3 w-3" />}
          {split ? "Unified" : "Split"}
        </HeaderToggle>
        <HeaderToggle title="Read the diff again" onClick={() => void load()} disabled={!root}>
          <RotateCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </HeaderToggle>
      </div>

      <div className="min-h-0 flex-1">
        {!root ? (
          <Note>Nothing to compare. Open a diff from the Git tab in the sidebar.</Note>
        ) : error !== null && !view ? (
          <Note tone="danger">{error}</Note>
        ) : view === undefined ? (
          <Note>Reading…</Note>
        ) : view === null ? (
          <Note>{root} is not in a git repository.</Note>
        ) : (
          <DiffView
            files={files}
            layout={split ? "split" : "unified"}
            header={
              <>
                {error !== null ? <Note tone="danger">{error}</Note> : null}
                {view.commit ? <CommitHeader commit={view.commit} /> : null}
              </>
            }
            empty={<Note>{emptyText(pane)}</Note>}
          />
        )}
      </div>
    </div>
  );
}

/** What is being compared, in a couple of words. */
function describe(pane: DiffPaneState, view: Loaded): string {
  if (pane.source === "commit") return `Commit ${view?.commit?.short ?? pane.rev ?? "HEAD"}`;
  return pane.source === "staged" ? "Staged changes" : "Working tree";
}

function emptyText(pane: DiffPaneState): string {
  const where = pane.path ? ` to ${pane.path}` : "";
  if (pane.source === "staged") return `Nothing staged${where}.`;
  if (pane.source === "commit") return `No changes${where} in this commit.`;
  return `No changes${where}.`;
}

function CommitHeader({ commit }: { commit: NonNullable<GitDiffView["commit"]> }) {
  return (
    <div className="border-b border-border px-3 py-2 font-sans">
      <p className="text-[length:var(--fs-12)] font-medium text-ink-1">{commit.subject}</p>
      {commit.body ? (
        <pre className="mt-1 whitespace-pre-wrap font-mono text-[length:var(--fs-11)] text-ink-2">
          {commit.body}
        </pre>
      ) : null}
      <p className="mt-1 text-[length:var(--fs-10)] text-ink-3">
        <span title={commit.email}>{commit.author}</span>
        {" · "}
        <span title={commit.date}>{commit.when}</span>
        {" · "}
        <span className="select-all font-mono" title="The full hash">
          {commit.hash}
        </span>
      </p>
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <p
      className={cn(
        "px-3 py-3 font-sans text-[length:var(--fs-11)]",
        tone === "danger" ? "whitespace-pre-wrap text-danger" : "text-ink-3",
      )}
    >
      {children}
    </p>
  );
}

function HeaderToggle({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex shrink-0 items-center gap-1 rounded-sm border border-hairline-strong px-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink-1 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

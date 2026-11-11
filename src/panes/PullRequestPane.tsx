/**
 * A GitHub pull request, in a pane: its conversation, its checks and its
 * files, and the handful of things one does from a pull request without
 * opening a browser — comment, check it out, merge it.
 *
 * Everything is read through the user's own `gh` (`src-tauri/src/github.rs`)
 * and nothing is kept but the description in `PullRequestPaneState`: which
 * checkout, which number, which view. So a restored pane fetches again, and the
 * only thing it shows before the network answers is the title it cached.
 *
 * When it reads:
 *
 *   - when it is opened, or told to refresh;
 *   - when it comes back into view, the moment someone is about to look at it
 *     after doing something elsewhere — pushing to the branch, say;
 *   - every thirty seconds, but only while a check is still running *and* the
 *     pane is on screen. A pull request whose checks have settled does not
 *     change unless someone does something, and a pane in a background tab is
 *     not worth a request a minute to anybody, or to GitHub's rate limit.
 *
 * The diff is read the first time the Files view is shown rather than with the
 * rest, because it is the expensive part and most visits never ask for it.
 *
 * Merging is the one action that cannot be taken back, so it is two clicks: the
 * button opens a bar that says exactly what will happen, with the method, and
 * only the button in that bar does it. When GitHub has said it cannot be merged
 * — a conflict, a draft, branch protection, no write access — the button is
 * disabled and its tooltip says which.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Columns2,
  ExternalLink,
  GitBranch,
  GitMerge,
  RotateCw,
  Rows2,
} from "lucide-react";

import {
  ActionButton,
  BucketIcon,
  CommentBox,
  CommentCard,
  GhProblem,
  Labels,
  Login,
  Notice,
  StatePill,
  useGh,
  type Loaded,
} from "@/components/github/GithubParts";
import { DiffView } from "@/components/diff/DiffView";
import { parseDiff } from "@/lib/diff";
import {
  checkSummaryText,
  checksPending,
  ghFailure,
  headLabel,
  MERGE_LABEL,
  mergeBlocker,
  paneTitle,
  plural,
  pullStatus,
  reviewDecisionText,
  reviewVerdict,
  sortChecks,
  summariseChecks,
  timeline,
} from "@/lib/github";
import {
  github,
  type GhCheck,
  type GhMergeMethod,
  type GhPull,
  type GhPullDiff,
  type GhRepo,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { PullRequestPaneState, PullRequestView } from "@/state/workspace";
import type { PaneProps } from "./types";

/** How often a pane with running checks reads them again, while it is on screen. */
const POLL_MS = 30_000;

export function PullRequestPane({
  pane,
  visible,
  onMeta,
  onFocus,
  onOpenPane,
}: PaneProps<PullRequestPaneState>) {
  const { root, number } = pane;
  const view: PullRequestView = pane.view ?? "conversation";
  const valid = root !== "" && number > 0;

  const load = useMemo(
    () => (valid ? () => github.pull(root, number) : null),
    [valid, root, number],
  );
  const pr = useGh(load);

  // The diff, once the Files view has been shown — and from then on, so that
  // switching views does not throw it away.
  const [wantDiff, setWantDiff] = useState(view === "files");
  useEffect(() => {
    if (view === "files") setWantDiff(true);
  }, [view]);
  const loadDiff = useMemo(
    () => (valid && wantDiff ? () => github.pullDiff(root, number) : null),
    [valid, wantDiff, root, number],
  );
  const diff = useGh(loadDiff);
  const files = useMemo(() => (diff.data ? parseDiff(diff.data.text) : []), [diff.data]);

  const refresh = () => {
    void pr.reload();
    if (wantDiff) void diff.reload();
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Back into view: read again. Not on the first render, which the loads
  // above have already covered.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) refreshRef.current();
    wasVisible.current = visible;
  }, [visible]);

  const pending = pr.data ? checksPending(pr.data.pull.checks) : false;
  useEffect(() => {
    if (!visible || !pending) return;
    const timer = window.setInterval(() => void pr.reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [visible, pending, pr.reload]);

  // The tab's name, cached in the pane so a restored one has it before the
  // network does.
  const title = pr.data ? paneTitle(number, pr.data.pull.title) : undefined;
  useEffect(() => {
    if (title !== undefined && title !== pane.title) onMeta({ title });
  }, [title, pane.title, onMeta]);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "quiet" | "danger"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  /** Run an action against GitHub, say how it went, and read the pull request again. */
  const act = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setNotice(null);
    try {
      const said = await work();
      if (said.trim()) setNotice({ tone: "quiet", text: said.trim() });
    } catch (failure) {
      setNotice({ tone: "danger", text: ghFailure(failure).message });
      throw failure;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const openUrl = (url: string | null | undefined) => {
    if (url) onOpenPane("browser", { url });
  };

  if (!valid) {
    return (
      <Frame onFocus={onFocus}>
        <p className="px-4 py-8 font-sans text-[length:var(--fs-12)] text-ink-3">
          No pull request to show. Open one from the GitHub tool in the sidebar.
        </p>
      </Frame>
    );
  }

  if (pr.data === undefined) {
    return (
      <Frame onFocus={onFocus}>
        {pr.error ? (
          <GhProblem error={pr.error} what="pr" onRetry={() => void pr.reload()} />
        ) : (
          <p className="px-4 py-8 font-sans text-[length:var(--fs-12)] text-ink-3">
            Reading pull request #{number}…
          </p>
        )}
      </Frame>
    );
  }

  const { repo, pull } = pr.data;
  const status = pullStatus(pull);
  const blocker = mergeBlocker(pull, repo);
  const decision = reviewDecisionText(pull.reviewDecision);
  const entries = timeline(pull);
  const summary = summariseChecks(pull.checks);
  const split = pane.layout === "split";

  return (
    <Frame onFocus={onFocus}>
      <header className="shrink-0 border-b border-border bg-surface-1 px-3 py-2 font-sans">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
          <h1 className="min-w-[12ch] flex-1 break-words text-[length:var(--fs-13)] font-medium leading-snug text-ink-1">
            {pull.title} <span className="font-normal text-ink-4">#{pull.number}</span>
          </h1>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <ActionButton
              primary={blocker === null}
              disabled={blocker !== null || busy !== null}
              title={blocker ?? `Merge into ${pull.baseRef}`}
              onClick={() => setConfirming(true)}
            >
              <GitMerge className="h-3 w-3" />
              Merge
            </ActionButton>
            <ActionButton
              disabled={busy !== null}
              title={`Check out ${headLabel(pull)} in this repository (gh pr checkout)`}
              onClick={() =>
                void act("checkout", () => github.checkout(root, number)).catch(() => {})
              }
            >
              <GitBranch className="h-3 w-3" />
              {busy === "checkout" ? "Checking out…" : "Check out"}
            </ActionButton>
            <ActionButton
              disabled={!pull.url}
              title="Open this pull request on GitHub in a browser pane"
              onClick={() => openUrl(pull.url)}
            >
              <ExternalLink className="h-3 w-3" />
              Open on GitHub
            </ActionButton>
            <ActionButton title="Read it again" onClick={refresh}>
              <RotateCw className={cn("h-3 w-3", (pr.loading || diff.loading) && "animate-spin")} />
            </ActionButton>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-11)] text-ink-3">
          <StatePill pull={status} />
          <span className="min-w-0">
            <Login person={pull.author} /> {status === "merged" ? "merged" : "wants to merge"}{" "}
            {plural(pull.commits, "commit")} into <Ref>{pull.baseRef}</Ref> from{" "}
            <Ref>{headLabel(pull)}</Ref>
          </span>
          <span className="font-mono text-[length:var(--fs-10)]">
            <span style={{ color: "var(--diff-add)" }}>+{pull.additions}</span>{" "}
            <span style={{ color: "var(--diff-del)" }}>−{pull.deletions}</span>
          </span>
          {decision ? <span className="text-ink-2">· {decision}</span> : null}
        </div>
        {pull.labels.length > 0 ? (
          <div className="mt-1.5">
            <Labels labels={pull.labels} />
          </div>
        ) : null}
      </header>

      {confirming && blocker === null ? (
        <MergeBar
          pull={pull}
          repo={repo}
          busy={busy === "merge"}
          onCancel={() => setConfirming(false)}
          onMerge={(method) =>
            void act("merge", () => github.merge(root, number, method))
              .then(() => setConfirming(false))
              .catch(() => {})
          }
        />
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      ) : null}
      {pr.error ? (
        <Notice tone="danger">
          Could not refresh: {pr.error.message}
        </Notice>
      ) : null}

      <nav className="flex shrink-0 items-end gap-0.5 border-b border-border bg-surface-1 px-2 pt-1 font-sans text-[length:var(--fs-11)]">
        <ViewTab
          active={view === "conversation"}
          onClick={() => onMeta({ view: undefined })}
          count={entries.length}
        >
          Conversation
        </ViewTab>
        <ViewTab
          active={view === "checks"}
          onClick={() => onMeta({ view: "checks" })}
          count={summary.total}
          title={checkSummaryText(summary)}
          icon={summary.total > 0 ? <BucketIcon bucket={rollupBucket(summary)} /> : null}
        >
          Checks
        </ViewTab>
        <ViewTab
          active={view === "files"}
          onClick={() => onMeta({ view: "files" })}
          count={pull.changedFiles}
        >
          Files
        </ViewTab>
        {view === "files" ? (
          <span className="mb-1 ml-auto flex items-center gap-2 self-center text-[length:var(--fs-10)]">
            {diff.data?.truncated ? (
              <span
                className="text-warn"
                title="The diff is larger than a pane will read. What is shown stops part way."
              >
                cut short
              </span>
            ) : null}
            <button
              type="button"
              title={split ? "Show the changes in one column" : "Show old and new side by side"}
              onClick={() => onMeta({ layout: split ? undefined : "split" })}
              className="flex items-center gap-1 rounded-sm border border-hairline-strong px-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
            >
              {split ? <Rows2 className="h-3 w-3" /> : <Columns2 className="h-3 w-3" />}
              {split ? "Unified" : "Split"}
            </button>
          </span>
        ) : null}
      </nav>

      <div className="min-h-0 flex-1">
        {view === "conversation" ? (
          <div className="h-full overflow-auto">
            <div className="mx-auto max-w-[90ch] space-y-3 px-4 py-3">
              <CommentCard
                author={pull.author}
                at={pull.createdAt}
                verdict="opened this pull request"
                body={pull.body}
              />
              {entries.map((entry) =>
                entry.type === "comment" ? (
                  <CommentCard
                    key={entry.comment.id}
                    author={entry.comment.author}
                    at={entry.at}
                    association={entry.comment.association}
                    body={entry.comment.body}
                    minimized={entry.comment.minimized}
                  />
                ) : (
                  <CommentCard
                    key={entry.review.id}
                    author={entry.review.author}
                    at={entry.at}
                    association={entry.review.association}
                    verdict={reviewVerdict(entry.review.state) ?? "reviewed"}
                    verdictTone={
                      entry.review.state === "approved"
                        ? "good"
                        : entry.review.state === "changes_requested"
                          ? "bad"
                          : undefined
                    }
                    body={entry.review.body}
                    emptyBody="No summary."
                  />
                ),
              )}
              <People pull={pull} />
              <CommentBox
                onSend={(body) => act("comment", () => github.comment(root, "pull", number, body))}
              />
            </div>
          </div>
        ) : view === "checks" ? (
          <Checks checks={pull.checks} onOpen={openUrl} />
        ) : (
          <Files loaded={diff} files={files} split={split} />
        )}
      </div>
    </Frame>
  );
}

function Frame({ onFocus, children }: { onFocus: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col bg-surface-0" onMouseDown={onFocus}>
      {children}
    </div>
  );
}

/** A branch name, set as code. */
function Ref({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm bg-surface-2 px-1 font-mono text-[length:var(--fs-10)] text-ink-2">
      {children}
    </code>
  );
}

function ViewTab({
  active,
  onClick,
  count,
  title,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  title?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-1.5",
        active ? "border-brand text-ink-1" : "border-transparent text-ink-3 hover:text-ink-1",
      )}
    >
      {icon}
      {children}
      <span className="rounded-full bg-surface-2 px-1.5 font-mono text-[length:var(--fs-9)] text-ink-3">
        {count}
      </span>
    </button>
  );
}

/** Reviewers and assignees, under the conversation — who this is waiting on. */
function People({ pull }: { pull: GhPull }) {
  if (pull.reviewRequests.length === 0 && pull.assignees.length === 0) return null;
  return (
    <div className="space-y-0.5 font-sans text-[length:var(--fs-11)] text-ink-3">
      {pull.reviewRequests.length > 0 ? (
        <p>
          Review requested from{" "}
          <span className="text-ink-2">{pull.reviewRequests.join(", ")}</span>
        </p>
      ) : null}
      {pull.assignees.length > 0 ? (
        <p>
          Assigned to{" "}
          <span className="text-ink-2">{pull.assignees.map((who) => who.login).join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The confirmation a merge goes through: the method, said in GitHub's words,
 * and the button that actually does it.
 */
function MergeBar({
  pull,
  repo,
  busy,
  onCancel,
  onMerge,
}: {
  pull: GhPull;
  repo: GhRepo;
  busy: boolean;
  onCancel: () => void;
  onMerge: (method: GhMergeMethod) => void;
}) {
  const [method, setMethod] = useState<GhMergeMethod>(repo.mergeMethods[0] ?? "merge");
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-surface-2 px-3 py-2 font-sans text-[length:var(--fs-11)] text-ink-2">
      <span className="text-ink-1">
        Merge #{pull.number} into <Ref>{pull.baseRef}</Ref>?
      </span>
      <span role="radiogroup" aria-label="Merge method" className="flex flex-wrap gap-1">
        {repo.mergeMethods.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={method === option}
            onClick={() => setMethod(option)}
            className={cn(
              "rounded-sm border px-2 py-[3px]",
              method === option
                ? "border-brand text-ink-1"
                : "border-hairline-strong text-ink-3 hover:text-ink-1",
            )}
          >
            {MERGE_LABEL[option]}
          </button>
        ))}
      </span>
      <span className="flex-1" />
      <ActionButton onClick={onCancel} disabled={busy}>
        Cancel
      </ActionButton>
      <ActionButton primary onClick={() => onMerge(method)} disabled={busy}>
        <GitMerge className="h-3 w-3" />
        {busy ? "Merging…" : "Confirm merge"}
      </ActionButton>
    </div>
  );
}

/* ── Checks ──────────────────────────────────────────────────────────────── */

function rollupBucket(summary: ReturnType<typeof summariseChecks>): GhCheck["bucket"] {
  if (summary.failed > 0) return "fail";
  if (summary.pending > 0) return "pending";
  return summary.passed > 0 ? "pass" : "neutral";
}

function Checks({ checks, onOpen }: { checks: GhCheck[]; onOpen: (url: string | null) => void }) {
  if (checks.length === 0) {
    return (
      <p className="px-4 py-6 font-sans text-[length:var(--fs-12)] text-ink-3">
        No checks have run on this pull request.
      </p>
    );
  }
  const summary = summariseChecks(checks);
  return (
    <div className="h-full overflow-auto font-sans">
      <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[length:var(--fs-12)] text-ink-2">
        <BucketIcon bucket={rollupBucket(summary)} />
        {checkSummaryText(summary)}
      </p>
      <ul>
        {sortChecks(checks).map((check, index) => (
          <li
            key={`${check.workflow ?? ""}/${check.name}/${index}`}
            className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[length:var(--fs-11)]"
          >
            <BucketIcon bucket={check.bucket} />
            <span className="min-w-0 flex-1">
              <span className="text-ink-1">
                {check.workflow ? <span className="text-ink-3">{check.workflow} / </span> : null}
                {check.name}
              </span>
              {check.description || check.detail ? (
                <span className="ml-2 text-ink-4">
                  {check.description ?? check.detail?.replace(/_/g, " ")}
                </span>
              ) : null}
            </span>
            <ActionButton
              disabled={!check.url}
              title={
                check.url ? "Open this check's details in a browser pane" : "This check has no page"
              }
              onClick={() => onOpen(check.url)}
            >
              <ExternalLink className="h-3 w-3" />
              Details
            </ActionButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Files ───────────────────────────────────────────────────────────────── */

/** The diff, drawn by `DiffView`, which brings its own file count and collapse-all. */
function Files({
  loaded,
  files,
  split,
}: {
  loaded: Loaded<GhPullDiff>;
  files: ReturnType<typeof parseDiff>;
  split: boolean;
}) {
  if (loaded.data === undefined) {
    return loaded.error ? (
      <GhProblem error={loaded.error} what="pr" onRetry={() => void loaded.reload()} />
    ) : (
      <p className="px-4 py-6 font-sans text-[length:var(--fs-12)] text-ink-3">Reading the diff…</p>
    );
  }
  return (
    <DiffView
      files={files}
      layout={split ? "split" : "unified"}
      empty={<p className="px-4 py-6 font-sans text-[length:var(--fs-12)] text-ink-3">No changes.</p>}
    />
  );
}

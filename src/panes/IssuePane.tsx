/**
 * A GitHub issue, in a pane: what was asked, what was said since, and the
 * reply box — with close and reopen beside it.
 *
 * The same arrangement as `PullRequestPane`, with less of it: read through the
 * user's own gh, nothing kept but the checkout, the number and a cached title,
 * read again when the pane comes back into view or someone asks. No polling at
 * all — an issue has no checks running, and nothing about it changes on its
 * own.
 *
 * Closing is not behind a confirmation the way merging is: it is undone by the
 * Reopen button that replaces it. Like GitHub's own, the button closes with
 * the comment in the box when there is one, so "closing because…" is one click
 * rather than two.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CircleDot, ExternalLink, RotateCw } from "lucide-react";

import {
  ActionButton,
  CommentBox,
  CommentCard,
  GhProblem,
  issueStatus,
  Labels,
  Login,
  Notice,
  StatePill,
  useGh,
  When,
} from "@/components/github/GithubParts";
import { canTriage, ghFailure, paneTitle, plural } from "@/lib/github";
import { github } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { IssuePaneState } from "@/state/workspace";
import type { PaneProps } from "./types";

export function IssuePane({
  pane,
  visible,
  onMeta,
  onFocus,
  onOpenPane,
}: PaneProps<IssuePaneState>) {
  const { root, number } = pane;
  const valid = root !== "" && number > 0;
  const load = useMemo(
    () => (valid ? () => github.issue(root, number) : null),
    [valid, root, number],
  );
  const issue = useGh(load);

  const reloadRef = useRef(issue.reload);
  reloadRef.current = issue.reload;
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) void reloadRef.current();
    wasVisible.current = visible;
  }, [visible]);

  const title = issue.data ? paneTitle(number, issue.data.issue.title) : undefined;
  useEffect(() => {
    if (title !== undefined && title !== pane.title) onMeta({ title });
  }, [title, pane.title, onMeta]);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "quiet" | "danger"; text: string } | null>(null);

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
      void issue.reload();
    }
  };

  if (!valid) {
    return (
      <Frame onFocus={onFocus}>
        <p className="px-4 py-8 font-sans text-[length:var(--fs-12)] text-ink-3">
          No issue to show. Open one from the GitHub tool in the sidebar.
        </p>
      </Frame>
    );
  }

  if (issue.data === undefined) {
    return (
      <Frame onFocus={onFocus}>
        {issue.error ? (
          <GhProblem error={issue.error} what="issue" onRetry={() => void issue.reload()} />
        ) : (
          <p className="px-4 py-8 font-sans text-[length:var(--fs-12)] text-ink-3">
            Reading issue #{number}…
          </p>
        )}
      </Frame>
    );
  }

  const { repo, issue: item } = issue.data;
  const open = item.state === "open";
  const mayTriage = canTriage(repo);

  /**
   * Close or reopen, posting the draft first when there is one — GitHub's
   * "Close with comment". The comment goes first so that a close which then
   * fails has still said what it meant to.
   */
  const setState = async (draft: string, clear: () => void) => {
    await act(open ? "close" : "reopen", async () => {
      if (draft.trim()) {
        await github.comment(root, "issue", number, draft);
        clear();
      }
      return github.setIssueState(root, number, open ? "closed" : "open");
    });
  };

  return (
    <Frame onFocus={onFocus}>
      <header className="shrink-0 border-b border-border bg-surface-1 px-3 py-2 font-sans">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
          <h1 className="min-w-[12ch] flex-1 break-words text-[length:var(--fs-13)] font-medium leading-snug text-ink-1">
            {item.title} <span className="font-normal text-ink-4">#{item.number}</span>
          </h1>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <ActionButton
              disabled={!item.url}
              title="Open this issue on GitHub in a browser pane"
              onClick={() => item.url && onOpenPane("browser", { url: item.url })}
            >
              <ExternalLink className="h-3 w-3" />
              Open on GitHub
            </ActionButton>
            <ActionButton title="Read it again" onClick={() => void issue.reload()}>
              <RotateCw className={cn("h-3 w-3", issue.loading && "animate-spin")} />
            </ActionButton>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-11)] text-ink-3">
          <StatePill issue={issueStatus(item.state, item.stateReason)} />
          <span>
            <Login person={item.author} /> opened this issue <When at={item.createdAt} /> ·{" "}
            {plural(item.comments.length, "comment")}
          </span>
        </div>
        {item.labels.length > 0 || item.assignees.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--fs-11)] text-ink-3">
            <Labels labels={item.labels} />
            {item.assignees.length > 0 ? (
              <span>
                Assigned to{" "}
                <span className="text-ink-2">{item.assignees.map((who) => who.login).join(", ")}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {notice ? (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      ) : null}
      {issue.error ? <Notice tone="danger">Could not refresh: {issue.error.message}</Notice> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[90ch] space-y-3 px-4 py-3">
          <CommentCard
            author={item.author}
            at={item.createdAt}
            verdict="opened this issue"
            body={item.body}
          />
          {item.comments.map((comment) => (
            <CommentCard
              key={comment.id}
              author={comment.author}
              at={comment.createdAt}
              association={comment.association}
              body={comment.body}
              minimized={comment.minimized}
            />
          ))}
          <CommentBox
            onSend={(body) => act("comment", () => github.comment(root, "issue", number, body))}
          >
            {(draft, clear) => (
              <ActionButton
                disabled={busy !== null || !mayTriage}
                title={
                  !mayTriage
                    ? "You do not have permission to close or reopen issues here."
                    : open
                      ? draft.trim()
                        ? "Post the comment, then close the issue"
                        : "Close the issue"
                      : "Reopen the issue"
                }
                onClick={() => void setState(draft, clear).catch(() => {})}
              >
                {open ? (
                  <CircleCheck className="h-3 w-3" style={{ color: "var(--term-magenta)" }} />
                ) : (
                  <CircleDot className="h-3 w-3" style={{ color: "var(--diff-add)" }} />
                )}
                {open
                  ? busy === "close"
                    ? "Closing…"
                    : draft.trim()
                      ? "Close with comment"
                      : "Close issue"
                  : busy === "reopen"
                    ? "Reopening…"
                    : "Reopen issue"}
              </ActionButton>
            )}
          </CommentBox>
        </div>
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

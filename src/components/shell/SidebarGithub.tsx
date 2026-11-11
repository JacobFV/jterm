/**
 * The sidebar's GitHub tool: the open pull requests and issues of the
 * repository the sidebar's directory is in. A click opens one in a pane,
 * wherever opened files go.
 *
 * It follows the focused terminal the way the Git tab does — it is handed the
 * same directory — and asks the user's own gh about it (`src-tauri/src/github.rs`).
 * When gh cannot answer, what is shown is what to do: install gh, `gh auth
 * login`, `cd` somewhere that is a GitHub checkout.
 *
 * Unlike the Git tab it does not poll. Git status is a local question that
 * costs nothing and changes with every save; this is two requests to GitHub
 * against a rate limit, about things that change when people do something. So
 * it reads when it is shown, when the window comes back into focus while it is
 * showing, when the directory changes, and when asked.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, RotateCw } from "lucide-react";

import {
  BucketIcon,
  GhProblem,
  LabelChip,
  StateIcon,
  useGh,
} from "@/components/github/GithubParts";
import { paneTitle, relativeTime } from "@/lib/github";
import { github, type GhIssueSummary, type GhPullSummary } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { PaneKind, PaneState } from "@/state/workspace";
import { HeaderButton, SidebarHeader, SidebarNote } from "./SidebarChrome";

export function SidebarGithub({
  cwd,
  active,
  onOpenPane,
  switcher,
}: {
  cwd: string;
  active: boolean;
  onOpenPane: (kind: PaneKind, seed: Partial<PaneState>) => void;
  switcher: ReactNode;
}) {
  // The directory the lists are about. It follows `cwd` only while the tool
  // is showing: a shell that `cd`s about while this is hidden would otherwise
  // cost three requests to GitHub per `cd`, for lists nobody is looking at.
  const [asked, setAsked] = useState(cwd);
  useEffect(() => {
    if (active) setAsked(cwd);
  }, [active, cwd]);
  const load = useMemo(() => () => github.lists(asked), [asked]);
  const lists = useGh(load);
  const data = lists.data;
  const reload = lists.reload;

  // Shown again: read again — unless the directory moved meanwhile, in which
  // case the new loader above is already reading.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && asked === cwd) void reload();
    wasActive.current = active;
    // Only the moment of being shown; the rest is read for its value then.
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onWindowFocus = () => void reload();
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [active, reload]);

  const open = useCallback(
    (kind: "pr" | "issue", item: { number: number; title: string }) =>
      onOpenPane(kind, {
        root: asked,
        number: item.number,
        title: paneTitle(item.number, item.title),
      }),
    [asked, onOpenPane],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <SidebarHeader
        switcher={switcher}
        title={data?.repo.nameWithOwner || "GitHub"}
        hint={data?.repo.url || asked}
      >
        {data?.repo.url ? (
          <HeaderButton
            label="Open the repository on GitHub"
            onClick={() => onOpenPane("browser", { url: data.repo.url })}
          >
            <ExternalLink className="h-3 w-3" />
          </HeaderButton>
        ) : null}
        <HeaderButton label="Refresh" onClick={() => void reload()}>
          <RotateCw className={cn("h-3 w-3", lists.loading && "animate-spin")} />
        </HeaderButton>
      </SidebarHeader>

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {lists.error && data === undefined ? (
          <GhProblem compact error={lists.error} onRetry={() => void reload()} />
        ) : null}
        {lists.error && data !== undefined ? (
          <SidebarNote tone="danger">{lists.error.message}</SidebarNote>
        ) : null}
        {data === undefined && !lists.error ? <SidebarNote>reading…</SidebarNote> : null}

        {data !== undefined ? (
          <>
            <Section label={`Pull requests (${data.pulls.length})`}>
              {data.pulls.length === 0 ? <SidebarNote>no open pull requests</SidebarNote> : null}
              {data.pulls.map((pull) => (
                <PullRow key={pull.number} pull={pull} onOpen={() => open("pr", pull)} />
              ))}
            </Section>
            <Section label={data.repo.issuesEnabled ? `Issues (${data.issues.length})` : "Issues"}>
              {!data.repo.issuesEnabled ? (
                <SidebarNote>issues are turned off for this repository</SidebarNote>
              ) : data.issues.length === 0 ? (
                <SidebarNote>no open issues</SidebarNote>
              ) : null}
              {data.issues.map((issue) => (
                <IssueRow key={issue.number} issue={issue} onOpen={() => open("issue", issue)} />
              ))}
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-border py-1 last:border-b-0">
      <div className="px-2 pb-0.5">
        <span className="pane-title text-[length:var(--fs-9)]">{label}</span>
      </div>
      {children}
    </div>
  );
}

/** Two lines: the state and title, then the number, who, and how it stands. */
function Row({
  icon,
  title,
  meta,
  hint,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  hint: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={hint}
      className="flex w-full items-start gap-1.5 px-2 py-[3px] text-left hover:bg-surface-2"
    >
      <span className="mt-[3px]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--fs-11)] text-ink-2">{title}</span>
        <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[length:var(--fs-9)] text-ink-4">
          {meta}
        </span>
      </span>
    </button>
  );
}

function PullRow({ pull, onOpen }: { pull: GhPullSummary; onOpen: () => void }) {
  const { checks } = pull;
  const bucket =
    checks.total === 0
      ? null
      : checks.failed > 0
        ? "fail"
        : checks.pending > 0
          ? "pending"
          : "pass";
  return (
    <Row
      icon={<StateIcon pull={pull.draft ? "draft" : "open"} />}
      title={pull.title}
      hint={
        `#${pull.number} ${pull.title}\n` +
        `${pull.author.login} wants to merge ${pull.headRef} into ${pull.baseRef}` +
        `${pull.draft ? "\nDraft" : ""}\n\nClick to open`
      }
      onOpen={onOpen}
      meta={
        <>
          <span className="font-mono">#{pull.number}</span>
          <span className="truncate">{pull.author.login}</span>
          {pull.draft ? <span>· draft</span> : null}
          {bucket !== null ? (
            <span
              className="flex shrink-0 items-center gap-0.5"
              title={
                `${checks.passed} passed, ${checks.failed} failed, ` +
                `${checks.pending} running, of ${checks.total}`
              }
            >
              ·
              <BucketIcon bucket={bucket} />
              <span className="font-mono">
                {checks.passed}/{checks.total}
              </span>
            </span>
          ) : null}
          {pull.updatedAt ? <span className="shrink-0">· {relativeTime(pull.updatedAt)}</span> : null}
        </>
      }
    />
  );
}

function IssueRow({ issue, onOpen }: { issue: GhIssueSummary; onOpen: () => void }) {
  return (
    <Row
      icon={<StateIcon issue="open" />}
      title={issue.title}
      hint={`#${issue.number} ${issue.title}\nopened by ${issue.author.login}${
        issue.labels.length ? `\n${issue.labels.map((label) => label.name).join(", ")}` : ""
      }\n\nClick to open`}
      onOpen={onOpen}
      meta={
        <>
          <span className="font-mono">#{issue.number}</span>
          <span className="shrink-0">{issue.author.login}</span>
          {issue.labels.slice(0, 3).map((label) => (
            <LabelChip key={label.name} label={label} compact />
          ))}
          {issue.labels.length > 3 ? <span>+{issue.labels.length - 3}</span> : null}
        </>
      }
    />
  );
}

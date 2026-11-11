/**
 * The pieces the pull request pane, the issue pane and the sidebar's GitHub
 * tool are built from: the state pill, labels, markdown from GitHub, a comment
 * box, and the empty state a failure turns into.
 *
 * Colour here means state and nothing else, as everywhere in jterm, and it
 * comes from the theme: open is the theme's diff green, closed its diff red,
 * merged its magenta — the hue GitHub uses for merged, taken from the palette
 * the user chose rather than from GitHub's — and a draft is plain ink. So a
 * pill in Solarized Light is legible on Solarized Light. The one colour that
 * is not the theme's is a label's own, which is GitHub data and is only ever a
 * small dot beside text in the theme's ink, never the background text sits on.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RotateCw,
  type LucideIcon,
} from "lucide-react";

import { advice, ghFailure, relativeTime, type PullStatus } from "@/lib/github";
import type { GhCheck, GhError, GhLabel, GhPerson } from "@/lib/ipc";
import { openExternal } from "@/lib/ipc";
import { linkTarget } from "@/lib/links";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/* ── Loading ─────────────────────────────────────────────────────────────── */

export interface Loaded<T> {
  /** `undefined` until the first answer. Kept through a failed refresh. */
  data: T | undefined;
  error: GhError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Ask gh for something, and again when told to.
 *
 * Answers can arrive out of order — a refresh clicked while the last read is
 * still out — so only the newest is allowed to land. A failed refresh keeps
 * what was already shown and sets `error` beside it: a pull request that was
 * on screen a minute ago is still worth reading while the network is down.
 * `load` changing (a different repository or number) starts over.
 */
export function useGh<T>(load: (() => Promise<T>) | null): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<GhError | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (load === null) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await load();
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
    } catch (failure) {
      if (mine !== generation.current) return;
      setError(ghFailure(failure));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    setData(undefined);
    setError(null);
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/* ── State ───────────────────────────────────────────────────────────────── */

const PULL_PILL: Record<PullStatus, { label: string; icon: LucideIcon; color?: string }> = {
  open: { label: "Open", icon: GitPullRequest, color: "var(--diff-add)" },
  draft: { label: "Draft", icon: GitPullRequestDraft },
  merged: { label: "Merged", icon: GitMerge, color: "var(--term-magenta)" },
  closed: { label: "Closed", icon: GitPullRequestClosed, color: "var(--diff-del)" },
};

export type IssueStatus = "open" | "completed" | "not_planned";

const ISSUE_PILL: Record<IssueStatus, { label: string; icon: LucideIcon; color?: string }> = {
  open: { label: "Open", icon: CircleDot, color: "var(--diff-add)" },
  completed: { label: "Closed", icon: CircleCheck, color: "var(--term-magenta)" },
  not_planned: { label: "Closed as not planned", icon: CircleSlash },
};

export function issueStatus(state: "open" | "closed", reason: string | null): IssueStatus {
  if (state === "open") return "open";
  return reason === "not_planned" || reason === "duplicate" ? "not_planned" : "completed";
}

/** The rounded pill at the head of a pane: an icon and a word, in the state's colour. */
export function StatePill({ pull, issue }: { pull?: PullStatus; issue?: IssueStatus }) {
  const spec = pull !== undefined ? PULL_PILL[pull] : ISSUE_PILL[issue ?? "open"];
  const Icon = spec.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[1px] font-sans text-[length:var(--fs-11)] font-medium",
        spec.color === undefined && "border-hairline-strong text-ink-3",
      )}
      style={spec.color ? { color: spec.color, borderColor: spec.color } : undefined}
    >
      <Icon className="h-3 w-3" />
      {spec.label}
    </span>
  );
}

/** The small icon a list row starts with: the same state, without the word. */
export function StateIcon({ pull, issue }: { pull?: PullStatus; issue?: IssueStatus }) {
  const spec = pull !== undefined ? PULL_PILL[pull] : ISSUE_PILL[issue ?? "open"];
  const Icon = spec.icon;
  return (
    <Icon
      className={cn("h-3 w-3 shrink-0", spec.color === undefined && "text-ink-4")}
      style={spec.color ? { color: spec.color } : undefined}
      aria-label={spec.label}
    />
  );
}

/** A check's state as an icon: a tick, a cross, a slow spin while it runs. */
export function BucketIcon({ bucket }: { bucket: GhCheck["bucket"] }) {
  switch (bucket) {
    case "pass":
      return (
        <CircleCheck
          className="h-3 w-3 shrink-0"
          style={{ color: "var(--diff-add)" }}
          aria-label="passed"
        />
      );
    case "fail":
      return (
        <CircleX
          className="h-3 w-3 shrink-0"
          style={{ color: "var(--diff-del)" }}
          aria-label="failed"
        />
      );
    case "pending":
      return (
        <CircleDashed
          className="h-3 w-3 shrink-0 animate-spin text-warn [animation-duration:3s]"
          aria-label="running"
        />
      );
    default:
      return <CircleMinus className="h-3 w-3 shrink-0 text-ink-4" aria-label={bucket} />;
  }
}

/* ── Labels and people ───────────────────────────────────────────────────── */

/** A label: its colour as a dot, its name in the theme's ink. `compact` drops the outline. */
export function LabelChip({ label, compact }: { label: GhLabel; compact?: boolean }) {
  return (
    <span
      title={label.description ?? undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-1 font-sans",
        compact
          ? "shrink-0 text-[length:var(--fs-9)] text-ink-3"
          : "rounded-full border border-hairline-strong px-1.5 text-[length:var(--fs-10)] leading-[1.6] text-ink-2",
      )}
    >
      {label.color ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          // Checked to be six hex digits by the backend before it got here.
          style={{ backgroundColor: `#${label.color}` }}
        />
      ) : null}
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export function Labels({ labels }: { labels: GhLabel[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
    </span>
  );
}

export function Login({ person }: { person: GhPerson }) {
  return (
    <span className="font-medium text-ink-1" title={person.name ?? undefined}>
      {person.login}
      {person.bot ? <span className="ml-1 font-normal text-ink-4">bot</span> : null}
    </span>
  );
}

/** "3 hours ago", with the exact time on hover. */
export function When({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {relativeTime(at)}
    </time>
  );
}

/* ── Markdown from GitHub ────────────────────────────────────────────────── */

/**
 * A body or comment, rendered.
 *
 * Through `renderMarkdown`, which sanitises — a comment is text a stranger
 * wrote, and this is a webview with the IPC bridge in it. Links go to the
 * user's browser, as from any other preview. Images are left pointing where
 * GitHub put them; on a private repository they need a login the webview does
 * not have, and show as their alt text, which is the honest failure.
 */
export function MarkdownBody({ text, empty }: { text: string; empty?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const mine = ++generation.current;
    if (!text.trim()) {
      host.innerHTML = "";
      return;
    }
    void renderMarkdown(text).then((html) => {
      if (generation.current === mine && hostRef.current !== null) host.innerHTML = html;
    });
  }, [text]);

  return (
    <>
      {!text.trim() ? (
        <p className="font-sans text-[length:var(--fs-12)] italic text-ink-4">
          {empty ?? "No description provided."}
        </p>
      ) : null}
      <div
        ref={hostRef}
        className="markdown gh-markdown"
        onClick={(event) => {
          const anchor = (event.target as HTMLElement | null)?.closest("a");
          const href = anchor?.getAttribute("href");
          if (!href) return;
          event.preventDefault();
          const target = linkTarget(href);
          if (target !== null) void openExternal(target);
        }}
      />
    </>
  );
}

/**
 * One entry in a conversation: who, when, and what they said. `verdict` is a
 * review's outcome, which sits in the header line ("approved these changes").
 */
export function CommentCard({
  author,
  at,
  association,
  verdict,
  verdictTone,
  body,
  emptyBody,
  minimized,
}: {
  author: GhPerson;
  at: string | null;
  association?: string | null;
  verdict?: string;
  verdictTone?: "good" | "bad";
  body: string;
  emptyBody?: string;
  minimized?: boolean;
}) {
  const [shown, setShown] = useState(!minimized);
  const role = association && !["none", "contributor"].includes(association)
    ? association.replace(/_/g, " ")
    : null;
  return (
    <article className="border border-border bg-surface-0">
      <header className="flex flex-wrap items-baseline gap-x-1.5 border-b border-border bg-surface-1 px-3 py-1.5 font-sans text-[length:var(--fs-11)] text-ink-3">
        <Login person={author} />
        {verdict ? (
          <span
            style={
              verdictTone === "good"
                ? { color: "var(--diff-add)" }
                : verdictTone === "bad"
                  ? { color: "var(--diff-del)" }
                  : undefined
            }
          >
            {verdict}
          </span>
        ) : (
          <span>commented</span>
        )}
        <When at={at} />
        <span className="flex-1" />
        {role ? (
          <span className="rounded-full border border-hairline-strong px-1.5 text-[length:var(--fs-10)] capitalize">
            {role}
          </span>
        ) : null}
      </header>
      <div className="px-3 py-2">
        {shown ? (
          <MarkdownBody text={body} empty={emptyBody} />
        ) : (
          <button
            type="button"
            onClick={() => setShown(true)}
            className="font-sans text-[length:var(--fs-11)] text-ink-4 underline decoration-dotted hover:text-ink-2"
          >
            Hidden on GitHub — show it anyway
          </button>
        )}
      </div>
    </article>
  );
}

/* ── Writing back ────────────────────────────────────────────────────────── */

/**
 * The box at the foot of a conversation. Ctrl/⌘+Enter sends. The text stays
 * put if sending fails, so a dropped network costs a retry, not the comment.
 */
export function CommentBox({
  onSend,
  disabled,
  children,
}: {
  /** Resolves when it was posted; rejects with something to show. */
  onSend: (body: string) => Promise<void>;
  disabled?: boolean;
  /** More buttons beside Comment — an issue's Close. Handed the draft. */
  children?: (draft: string, clear: () => void) => ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const can = draft.trim() !== "" && !sending && !disabled;

  const send = async () => {
    if (!can) return;
    setSending(true);
    try {
      await onSend(draft);
      setDraft("");
    } catch {
      // The pane has already said why; the draft stays for another go.
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border border-border bg-surface-0">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        rows={4}
        spellCheck
        placeholder="Leave a comment (markdown)"
        aria-label="Comment"
        className="block w-full resize-y bg-transparent px-3 py-2 font-sans text-[length:var(--fs-12)] text-ink-1 outline-none placeholder:text-ink-4"
      />
      <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-1 px-2 py-1.5">
        {children?.(draft, () => setDraft(""))}
        <ActionButton
          primary
          disabled={!can}
          onClick={() => void send()}
          title="Post this comment on GitHub (Ctrl+Enter)"
        >
          {sending ? "Commenting…" : "Comment"}
        </ActionButton>
      </div>
    </div>
  );
}

/** A labelled button in a pane's header or footer. */
export function ActionButton({
  onClick,
  disabled,
  title,
  primary,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** The tooltip — for a disabled button, why. */
  title?: string;
  primary?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    // Wrapped, because a disabled button gets no pointer events and so no
    // tooltip — and a disabled button's tooltip is where it says why.
    <span title={title} className="inline-flex shrink-0">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm border px-2 py-[3px] font-sans text-[length:var(--fs-11)] disabled:pointer-events-none disabled:opacity-40",
          primary
            ? "border-brand bg-brand text-brand-foreground hover:opacity-90"
            : danger
              ? "border-hairline-strong text-danger hover:border-danger"
              : "border-hairline-strong text-ink-2 hover:bg-surface-2 hover:text-ink-1",
        )}
      >
        {children}
      </button>
    </span>
  );
}

/* ── When it did not work ────────────────────────────────────────────────── */

/** A hint with `backticked` commands set in mono, so they read as something to type. */
export function Hint({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, index) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code
            key={index}
            className="select-all rounded-sm bg-surface-2 px-1 font-mono text-[0.95em] text-ink-1"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * What a pane or the sidebar shows instead of content when gh could not
 * answer: what is wrong, what to do, gh's own words underneath, and a way to
 * try again once it is done.
 */
export function GhProblem({
  error,
  what,
  onRetry,
  compact,
}: {
  error: GhError;
  what?: "pr" | "issue" | "list";
  onRetry?: () => void;
  /** The sidebar's narrower version. */
  compact?: boolean;
}) {
  const { title, hint } = advice(error.kind, what);
  return (
    <div className={cn("font-sans", compact ? "px-2 py-2" : "mx-auto max-w-[56ch] px-4 py-8")}>
      <p
        className={cn(
          "font-medium text-ink-1",
          compact ? "text-[length:var(--fs-11)]" : "text-[length:var(--fs-13)]",
        )}
      >
        {title}
      </p>
      {hint ? (
        <p className={cn("mt-1 text-ink-3", compact ? "text-[length:var(--fs-10)]" : "text-[length:var(--fs-12)]")}>
          <Hint text={hint} />
        </p>
      ) : null}
      {error.message ? (
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[length:var(--fs-10)] text-ink-4">
          {error.message}
        </pre>
      ) : null}
      {onRetry ? (
        <div className="mt-3">
          <ActionButton onClick={onRetry}>
            <RotateCw className="h-3 w-3" />
            Refresh
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}

/** A one-line notice: what an action said, or why it failed. */
export function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "quiet" | "danger";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b border-border px-3 py-1.5 font-sans text-[length:var(--fs-11)]",
        tone === "danger" ? "text-danger" : "text-ink-3",
      )}
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-ink-4 hover:text-ink-1"
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

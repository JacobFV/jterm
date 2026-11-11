/**
 * The decisions behind the pull request and issue panes and the sidebar's
 * GitHub tool, kept out of the components so they can be tested in node: what
 * a failure tells the user to do, which state pill a pull request wears,
 * whether it can be merged and why not, and the order a conversation reads in.
 *
 * The data itself comes from the user's own `gh` — see `src-tauri/src/github.rs`
 * and `github` in `lib/ipc.ts`.
 */

import type {
  GhCheck,
  GhCheckSummary,
  GhComment,
  GhError,
  GhErrorKind,
  GhPull,
  GhRepo,
  GhReview,
} from "./ipc";

const KINDS: GhErrorKind[] = [
  "missing",
  "auth",
  "notRepo",
  "notGithub",
  "notFound",
  "offline",
  "invalid",
  "failed",
];

/**
 * A rejected `github` call, as a kind and a message.
 *
 * The backend rejects with `{ kind, message }`; anything else — a thrown
 * `Error`, a string from a Tauri failure that never reached the command — is
 * `failed`, with whatever words it had.
 */
export function ghFailure(error: unknown): GhError {
  if (typeof error === "object" && error !== null) {
    const { kind, message } = error as Record<string, unknown>;
    if (typeof kind === "string" && KINDS.includes(kind as GhErrorKind)) {
      return { kind: kind as GhErrorKind, message: typeof message === "string" ? message : "" };
    }
    if (error instanceof Error) return { kind: "failed", message: error.message };
  }
  return { kind: "failed", message: String(error ?? "").replace(/^Error:\s*/, "") };
}

export interface Advice {
  /** What is wrong, in a few words. */
  title: string;
  /** What to do about it. A backticked span is a command to type. */
  hint: string;
}

/**
 * What each failure tells the user to do. Each kind is something different to
 * fix, so each says a different thing — "not a GitHub repository" when the
 * truth is "you are logged out" sends someone looking in the wrong place.
 */
export function advice(kind: GhErrorKind, what: "pr" | "issue" | "list" = "list"): Advice {
  switch (kind) {
    case "missing":
      return {
        title: "The GitHub CLI is not installed",
        hint:
          "jterm reads GitHub through gh. Install it from cli.github.com, " +
          "run `gh auth login`, then refresh.",
      };
    case "auth":
      return {
        title: "Not signed in to GitHub",
        hint: "Run `gh auth login` in a terminal, then refresh.",
      };
    case "notRepo":
      return {
        title: "Not a git repository",
        hint: "This follows the focused terminal. `cd` into a checkout of a GitHub repository.",
      };
    case "notGithub":
      return {
        title: "No GitHub remote",
        hint:
          "None of this repository's remotes is on a GitHub host gh knows. Add one with " +
          "`git remote add`, or sign in to an Enterprise host with " +
          "`gh auth login --hostname <host>`.",
      };
    case "notFound":
      return {
        title:
          what === "pr" ? "No such pull request" : what === "issue" ? "No such issue" : "Not found",
        hint: "It is not in this repository, or this account cannot see it.",
      };
    case "offline":
      return {
        title: "GitHub did not answer",
        hint: "Check the network connection, then refresh.",
      };
    case "invalid":
    case "failed":
      return { title: "gh could not do that", hint: "" };
  }
}

/** The four states a pull request's pill can show. */
export type PullStatus = "open" | "draft" | "merged" | "closed";

export function pullStatus(pull: Pick<GhPull, "state" | "draft">): PullStatus {
  if (pull.state === "merged") return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

/** Permissions that may merge, as gh reports `viewerPermission`. */
const CAN_MERGE = new Set(["admin", "maintain", "write"]);
/** And those that may close and reopen issues. */
const CAN_TRIAGE = new Set(["admin", "maintain", "write", "triage"]);

/**
 * Why the Merge button is disabled, or `null` when it is not.
 *
 * Only reasons that are certain: GitHub works mergeability out lazily, and a
 * pull request nobody has looked at lately is `unknown` until somebody asks.
 * That is not a reason to refuse; gh will say if it cannot. What *is* certain
 * is a conflict, a draft, a closed pull request, branch protection saying no,
 * or a viewer without write access — and those each say so on the button's
 * tooltip, which is the whole point of disabling rather than hiding it.
 */
export function mergeBlocker(pull: GhPull, repo: GhRepo): string | null {
  if (pull.state === "merged") return "Already merged.";
  if (pull.state === "closed") return "This pull request is closed.";
  if (pull.draft) return "A draft cannot be merged. Mark it ready for review on GitHub first.";
  if (repo.permission !== null && !CAN_MERGE.has(repo.permission)) {
    return "You do not have write access to this repository.";
  }
  if (repo.mergeMethods.length === 0) return "This repository allows no merge method.";
  if (pull.mergeable === "conflicting" || pull.mergeState === "dirty") {
    return `There are conflicts with ${pull.baseRef || "the base branch"} to resolve first.`;
  }
  if (pull.mergeState === "behind") {
    return `The branch is behind ${pull.baseRef || "the base branch"} and must be updated first.`;
  }
  if (pull.mergeState === "blocked") {
    return pull.reviewDecision === "changes_requested"
      ? "Changes were requested in a review."
      : pull.reviewDecision === "review_required"
        ? "Branch protection requires an approving review."
        : "Branch protection is blocking the merge — required checks or reviews.";
  }
  return null;
}

/** Whether the viewer may close or reopen an issue, as far as gh said. */
export function canTriage(repo: GhRepo): boolean {
  return repo.permission === null || CAN_TRIAGE.has(repo.permission);
}

export const MERGE_LABEL: Record<GhRepo["mergeMethods"][number], string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** True while any check has not finished — the only time a pane polls. */
export function checksPending(checks: GhCheck[]): boolean {
  return checks.some((check) => check.bucket === "pending");
}

/** Checks in the order worth reading them: failures first, then running, then the rest. */
export function sortChecks(checks: GhCheck[]): GhCheck[] {
  const rank: Record<GhCheck["bucket"], number> = {
    fail: 0,
    pending: 1,
    cancelled: 2,
    pass: 3,
    neutral: 4,
    skipped: 5,
  };
  return [...checks].sort(
    (a, b) => rank[a.bucket] - rank[b.bucket] || a.name.localeCompare(b.name),
  );
}

/** A check summary in a few words, for the sidebar and the Checks tab. */
export function checkSummaryText(summary: GhCheckSummary): string {
  if (summary.total === 0) return "No checks";
  if (summary.failed > 0) return `${summary.failed} of ${summary.total} checks failing`;
  if (summary.pending > 0) return `${summary.pending} of ${summary.total} checks running`;
  return summary.passed === summary.total
    ? `All ${summary.total} checks passed`
    : `${summary.passed} of ${summary.total} checks passed`;
}

export function summariseChecks(checks: GhCheck[]): GhCheckSummary {
  return {
    total: checks.length,
    passed: checks.filter((check) => check.bucket === "pass").length,
    failed: checks.filter((check) => check.bucket === "fail").length,
    pending: checks.filter((check) => check.bucket === "pending").length,
  };
}

export type TimelineEntry =
  | { type: "comment"; at: string | null; comment: GhComment }
  | { type: "review"; at: string | null; review: GhReview };

/**
 * A pull request's comments and reviews, in the order they happened.
 *
 * A review with no text and no verdict — a "commented" review that was only
 * inline remarks on lines of code — has nothing to show in a conversation that
 * does not show those lines, and is left out. An approval with no text is
 * kept: the approval is the content.
 */
export function timeline(pull: Pick<GhPull, "comments" | "reviews">): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...pull.comments.map((comment) => ({
      type: "comment" as const,
      at: comment.createdAt,
      comment,
    })),
    ...pull.reviews
      .filter((review) => review.body.trim() !== "" || reviewVerdict(review.state) !== null)
      .map((review) => ({ type: "review" as const, at: review.submittedAt, review })),
  ];
  // Stable, and an entry with no date keeps its place at the end.
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = a.entry.at ?? "￿";
      const bt = b.entry.at ?? "￿";
      return at < bt ? -1 : at > bt ? 1 : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** What a review decided, in words, or `null` for a plain comment. */
export function reviewVerdict(state: string | null): string | null {
  switch (state) {
    case "approved":
      return "approved these changes";
    case "changes_requested":
      return "requested changes";
    case "dismissed":
      return "reviewed (dismissed)";
    default:
      return null;
  }
}

/** The review decision on a pull request, for its header. */
export function reviewDecisionText(decision: string | null): string | null {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Review required";
    default:
      return null;
  }
}

/**
 * "3 hours ago", in the words GitHub uses. `now` is a parameter so the tests
 * can hold the clock still.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const steps: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
  ];
  if (seconds < 45) return "just now";
  let value = seconds;
  for (const [size, unit] of steps) {
    if (value < size) return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    value = Math.round(value / size);
  }
  return `${value} year${value === 1 ? "" : "s"} ago`;
}

/** The title a pane puts on its tab: the number, then GitHub's title. */
export function paneTitle(number: number, title: string): string {
  return `#${number} ${title}`.slice(0, 120);
}

/** A pull request's head as GitHub writes it: `branch`, or `owner:branch` from a fork. */
export function headLabel(pull: Pick<GhPull, "headRef" | "headOwner" | "crossRepository">): string {
  return pull.crossRepository && pull.headOwner
    ? `${pull.headOwner}:${pull.headRef}`
    : pull.headRef;
}

/** "N commits", "1 commit". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

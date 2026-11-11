import { describe, expect, it } from "vitest";

import {
  advice,
  canTriage,
  checkSummaryText,
  checksPending,
  ghFailure,
  headLabel,
  mergeBlocker,
  paneTitle,
  pullStatus,
  relativeTime,
  sortChecks,
  timeline,
} from "./github";
import type { GhCheck, GhPull, GhRepo } from "./ipc";

const REPO: GhRepo = {
  nameWithOwner: "octo/repo",
  url: "https://github.com/octo/repo",
  mergeMethods: ["merge", "squash", "rebase"],
  permission: "write",
  defaultBranch: "main",
  issuesEnabled: true,
};

const person = (login: string) => ({ login, name: null, bot: false });

const PULL: GhPull = {
  number: 12,
  title: "Fix the thing",
  state: "open",
  draft: false,
  author: person("octocat"),
  baseRef: "main",
  headRef: "fix",
  headOwner: "octocat",
  crossRepository: false,
  body: "",
  labels: [],
  assignees: [],
  reviewRequests: [],
  reviewDecision: null,
  mergeable: "mergeable",
  mergeState: "clean",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  commits: 1,
  comments: [],
  reviews: [],
  checks: [],
  url: "https://github.com/octo/repo/pull/12",
  createdAt: null,
  updatedAt: null,
  mergedAt: null,
  closedAt: null,
};

const check = (name: string, bucket: GhCheck["bucket"]): GhCheck => ({
  name,
  workflow: null,
  bucket,
  detail: null,
  url: null,
  description: null,
  startedAt: null,
  completedAt: null,
});

describe("ghFailure", () => {
  it("reads the backend's kind and message, and calls anything else a failure", () => {
    expect(ghFailure({ kind: "auth", message: "log in" })).toEqual({
      kind: "auth",
      message: "log in",
    });
    expect(ghFailure({ kind: "nonsense", message: "x" }).kind).toBe("failed");
    expect(ghFailure(new Error("boom"))).toEqual({ kind: "failed", message: "boom" });
    expect(ghFailure("Error: plain")).toEqual({ kind: "failed", message: "plain" });
  });

  it("tells each failure apart, with something to do about it", () => {
    expect(advice("auth").hint).toContain("gh auth login");
    expect(advice("missing").hint).toContain("cli.github.com");
    expect(advice("notGithub").title).toBe("No GitHub remote");
    expect(advice("notFound", "pr").title).toBe("No such pull request");
    expect(advice("notFound", "issue").title).toBe("No such issue");
    const titles = new Set(
      (["missing", "auth", "notRepo", "notGithub", "notFound", "offline"] as const).map(
        (kind) => advice(kind).title,
      ),
    );
    expect(titles.size).toBe(6);
  });
});

describe("a pull request's state", () => {
  it("is merged or closed whatever the draft flag says, and draft only while open", () => {
    expect(pullStatus({ state: "open", draft: false })).toBe("open");
    expect(pullStatus({ state: "open", draft: true })).toBe("draft");
    expect(pullStatus({ state: "merged", draft: true })).toBe("merged");
    expect(pullStatus({ state: "closed", draft: false })).toBe("closed");
  });

  it("names its head as owner:branch only when it comes from a fork", () => {
    expect(headLabel(PULL)).toBe("fix");
    expect(headLabel({ ...PULL, crossRepository: true, headOwner: "them" })).toBe("them:fix");
  });

  it("puts the number in front of the title on a tab", () => {
    expect(paneTitle(12, "Fix the thing")).toBe("#12 Fix the thing");
    expect(paneTitle(1, "x".repeat(500))).toHaveLength(120);
  });
});

describe("mergeBlocker", () => {
  it("lets a clean pull request, or one GitHub has not worked out yet, be merged", () => {
    expect(mergeBlocker(PULL, REPO)).toBeNull();
    expect(mergeBlocker({ ...PULL, mergeable: "unknown", mergeState: "unknown" }, REPO)).toBeNull();
    // Unstable is failing non-required checks: GitHub lets it merge.
    expect(mergeBlocker({ ...PULL, mergeState: "unstable" }, REPO)).toBeNull();
  });

  it("says why when it cannot be", () => {
    expect(mergeBlocker({ ...PULL, state: "merged" }, REPO)).toMatch(/Already merged/);
    expect(mergeBlocker({ ...PULL, state: "closed" }, REPO)).toMatch(/closed/);
    expect(mergeBlocker({ ...PULL, draft: true }, REPO)).toMatch(/draft/i);
    expect(mergeBlocker({ ...PULL, mergeable: "conflicting" }, REPO)).toMatch(
      /conflicts with main/,
    );
    expect(mergeBlocker({ ...PULL, mergeState: "behind" }, REPO)).toMatch(/behind main/);
    expect(
      mergeBlocker({ ...PULL, mergeState: "blocked", reviewDecision: "review_required" }, REPO),
    ).toMatch(/approving review/);
    expect(mergeBlocker({ ...PULL, mergeState: "blocked" }, REPO)).toMatch(/Branch protection/);
    expect(mergeBlocker(PULL, { ...REPO, permission: "read" })).toMatch(/write access/);
    expect(mergeBlocker(PULL, { ...REPO, mergeMethods: [] })).toMatch(/no merge method/);
  });

  it("does not refuse when gh did not say what the viewer may do", () => {
    expect(mergeBlocker(PULL, { ...REPO, permission: null })).toBeNull();
    expect(canTriage({ ...REPO, permission: null })).toBe(true);
    expect(canTriage({ ...REPO, permission: "triage" })).toBe(true);
    expect(canTriage({ ...REPO, permission: "read" })).toBe(false);
  });
});

describe("checks", () => {
  it("count as pending while any one is running", () => {
    expect(checksPending([check("a", "pass"), check("b", "pending")])).toBe(true);
    expect(checksPending([check("a", "pass"), check("b", "fail")])).toBe(false);
  });

  it("read failures first, then running ones", () => {
    const sorted = sortChecks([
      check("b", "pass"),
      check("z", "skipped"),
      check("c", "pending"),
      check("a", "fail"),
      check("a", "pass"),
    ]);
    expect(sorted.map((entry) => `${entry.name}:${entry.bucket}`)).toEqual([
      "a:fail",
      "c:pending",
      "a:pass",
      "b:pass",
      "z:skipped",
    ]);
  });

  it("sum up in a few words", () => {
    expect(checkSummaryText({ total: 0, passed: 0, failed: 0, pending: 0 })).toBe("No checks");
    expect(checkSummaryText({ total: 3, passed: 1, failed: 1, pending: 1 })).toBe(
      "1 of 3 checks failing",
    );
    expect(checkSummaryText({ total: 3, passed: 2, failed: 0, pending: 1 })).toBe(
      "1 of 3 checks running",
    );
    expect(checkSummaryText({ total: 2, passed: 2, failed: 0, pending: 0 })).toBe(
      "All 2 checks passed",
    );
  });
});

describe("timeline", () => {
  const comment = (id: string, createdAt: string | null) => ({
    id,
    author: person("a"),
    association: null,
    body: id,
    createdAt,
    url: null,
    minimized: false,
  });
  const review = (id: string, state: string, body: string, submittedAt: string) => ({
    id,
    author: person("r"),
    association: null,
    body,
    state,
    submittedAt,
  });

  it("interleaves comments and reviews by time, and drops reviews with nothing to show", () => {
    const entries = timeline({
      comments: [comment("c2", "2026-01-03T00:00:00Z"), comment("c1", "2026-01-01T00:00:00Z")],
      reviews: [
        review("approve", "approved", "", "2026-01-02T00:00:00Z"),
        review("inline-only", "commented", "", "2026-01-02T12:00:00Z"),
        review("said", "commented", "nit: rename", "2026-01-04T00:00:00Z"),
      ],
    });
    expect(
      entries.map((entry) => (entry.type === "comment" ? entry.comment.id : entry.review.id)),
    ).toEqual(["c1", "approve", "c2", "said"]);
  });

  it("keeps an undated entry, at the end", () => {
    const entries = timeline({
      comments: [comment("undated", null), comment("dated", "2026-01-01T00:00:00Z")],
      reviews: [],
    });
    expect(entries.map((entry) => entry.type === "comment" && entry.comment.id)).toEqual([
      "dated",
      "undated",
    ]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  it("speaks in the largest unit that fits", () => {
    expect(relativeTime("2026-11-11T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-11-11T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-11-11T11:00:00Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-11-08T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2024-11-11T12:00:00Z", now)).toBe("2 years ago");
  });

  it("is empty for a date it cannot read", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("yesterday", now)).toBe("");
  });
});

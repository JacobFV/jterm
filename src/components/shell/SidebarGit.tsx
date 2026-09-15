/**
 * The sidebar's Git tab: the repository the sidebar's directory is in, what has
 * changed, and staging, committing, pulling and pushing.
 *
 * Deliberately the everyday half of git and nothing more. Anything with a
 * choice in it — a rebase, a conflicted merge, a branch to pick — belongs in the
 * terminal beside it, where git can ask its questions. So there is no discard
 * button either: throwing work away should take a command someone typed, not a
 * click someone slipped on.
 *
 * Status is polled while the tab is on screen, because git has no way to say
 * the repository changed and the terminal next door is changing it constantly.
 * The poll is cheap — see the lock note in `src-tauri/src/git.rs` for why it is
 * also harmless to the `git` commands running in that terminal.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Minus,
  Plus,
  RotateCw,
} from "lucide-react";

import { git, type GitAction, type GitCommit, type GitFile, type GitStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { HeaderButton, SidebarHeader, SidebarNote, baseName, errorText } from "./SidebarChrome";

const POLL_MS = 3000;

export function SidebarGit({
  cwd,
  active,
  onOpen,
  switcher,
}: {
  cwd: string;
  active: boolean;
  onOpen: (path: string) => void;
  switcher: ReactNode;
}) {
  // `undefined` is "not asked yet", `null` is "asked: not a repository".
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<{ key: string; text: string } | null>(null);
  const [log, setLog] = useState<GitCommit[] | null>(null);
  const shownRef = useRef("");

  const refresh = useCallback(async () => {
    try {
      const next = await git.status(cwd);
      // Compared as text, so a poll that finds nothing new does not re-render
      // the list — and does not reset the scroll of someone reading it.
      const shown = JSON.stringify(next);
      if (shown !== shownRef.current) {
        shownRef.current = shown;
        setStatus(next);
      }
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [cwd]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  // A different repository is a different list; an open diff or history from
  // the last one would be describing files that are not these.
  const root = status?.root ?? null;
  useEffect(() => {
    setOpen(null);
    setLog(null);
  }, [root]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setSaid(null);
    try {
      const output = await work();
      if (typeof output === "string" && output.trim()) setSaid(output.trim());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const action = (name: GitAction) => run(name, () => git.action(status?.root ?? cwd, name));

  const toggleDiff = async (file: GitFile, staged: boolean) => {
    if (!root) return;
    const key = `${staged ? "s" : "u"}:${file.path}`;
    if (open?.key === key) {
      setOpen(null);
      return;
    }
    setOpen({ key, text: "reading…" });
    try {
      const text = await git.diff(root, file.path, staged, file.untracked);
      setOpen((current) => (current?.key === key ? { key, text: text || "no textual changes" } : current));
    } catch (failure) {
      setOpen((current) => (current?.key === key ? { key, text: errorText(failure) } : current));
    }
  };

  const toggleLog = async () => {
    if (log !== null || !root) {
      setLog(null);
      return;
    }
    try {
      setLog(await git.log(root, 30));
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const staged = status?.files.filter((file) => !file.untracked && file.staged !== ".") ?? [];
  const changes = status?.files.filter((file) => file.untracked || file.unstaged !== ".") ?? [];
  const canCommit = staged.length > 0 && message.trim() !== "" && busy === null;

  const commit = () => {
    if (!canCommit || !root) return;
    void run("commit", async () => {
      const output = await git.commit(root, message);
      setMessage("");
      return output.split("\n")[0];
    });
  };

  const title =
    status === undefined
      ? "Git"
      : status === null
        ? "Git"
        : (status.branch ?? "detached HEAD");

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <SidebarHeader switcher={switcher} title={title} hint={status?.root ?? cwd}>
        {status ? (
          <>
            <HeaderButton
              label={status.behind ? `Pull (${status.behind} behind)` : "Pull"}
              disabled={busy !== null}
              onClick={() => void action("pull")}
            >
              <ArrowDown className="h-3 w-3" />
              {status.behind ? <Count>{status.behind}</Count> : null}
            </HeaderButton>
            <HeaderButton
              label={status.ahead ? `Push (${status.ahead} ahead)` : "Push"}
              disabled={busy !== null}
              onClick={() => void action("push")}
            >
              <ArrowUp className="h-3 w-3" />
              {status.ahead ? <Count>{status.ahead}</Count> : null}
            </HeaderButton>
            <HeaderButton label="Recent commits" active={log !== null} onClick={() => void toggleLog()}>
              <History className="h-3 w-3" />
            </HeaderButton>
          </>
        ) : null}
        <HeaderButton label="Refresh" onClick={() => void refresh()}>
          <RotateCw className={cn("h-3 w-3", busy !== null && "animate-spin")} />
        </HeaderButton>
      </SidebarHeader>

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {error ? <SidebarNote tone="danger">{error}</SidebarNote> : null}
        {said ? <SidebarNote>{said}</SidebarNote> : null}

        {status === undefined ? <SidebarNote>reading…</SidebarNote> : null}

        {status === null ? (
          <div className="px-2 py-2">
            <p className="mb-2 text-[length:var(--fs-11)] text-ink-3">
              {baseName(cwd)} is not in a git repository.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void action("init")}
              className="border border-border px-2 py-1 text-[length:var(--fs-11)] text-ink-2 hover:border-ink-4 hover:text-ink-1 disabled:opacity-40"
            >
              Initialise a repository here
            </button>
          </div>
        ) : null}

        {status ? (
          <>
            {log !== null ? (
              <Section label="Recent commits">
                {log.length === 0 ? <SidebarNote>no commits yet</SidebarNote> : null}
                {log.map((entry) => (
                  <div
                    key={entry.hash}
                    title={`${entry.hash}\n${entry.author}, ${entry.when}\n\n${entry.subject}`}
                    className="flex items-baseline gap-1.5 px-2 py-[2px]"
                  >
                    <span className="shrink-0 font-mono text-[length:var(--fs-9)] text-ink-4">
                      {entry.short}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--fs-10)] text-ink-2">
                      {entry.subject}
                    </span>
                  </div>
                ))}
              </Section>
            ) : null}

            <div className="border-b border-border px-1.5 py-1.5">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    commit();
                  }
                }}
                rows={2}
                spellCheck
                placeholder="Commit message"
                aria-label="Commit message"
                className="block w-full resize-y border border-border bg-surface-0 px-1.5 py-1 text-[length:var(--fs-11)] text-ink-1 outline-none placeholder:text-ink-4 focus:border-brand"
              />
              <button
                type="button"
                disabled={!canCommit}
                onClick={commit}
                title="Commit the staged changes (Ctrl+Enter)"
                className="mt-1 w-full border border-border py-1 text-[length:var(--fs-11)] text-ink-2 hover:border-brand hover:text-ink-1 disabled:opacity-40"
              >
                {busy === "commit"
                  ? "Committing…"
                  : staged.length === 0
                    ? "Nothing staged"
                    : `Commit ${staged.length} staged ${staged.length === 1 ? "file" : "files"}`}
              </button>
            </div>

            {status.files.length === 0 ? <SidebarNote>working tree clean</SidebarNote> : null}
            {status.truncated ? <SidebarNote>showing the first {status.files.length} files</SidebarNote> : null}

            {staged.length > 0 ? (
              <Section
                label={`Staged (${staged.length})`}
                action={
                  <HeaderButton
                    label="Unstage everything"
                    disabled={busy !== null}
                    onClick={() => void run("unstage", () => git.unstage(status.root, staged.map((f) => f.path)))}
                  >
                    <Minus className="h-3 w-3" />
                  </HeaderButton>
                }
              >
                {staged.map((file) => (
                  <FileRow
                    key={`s:${file.path}`}
                    file={file}
                    letter={file.staged}
                    diff={open?.key === `s:${file.path}` ? open.text : null}
                    onDiff={() => void toggleDiff(file, true)}
                    onOpen={() => onOpen(`${status.root}/${file.path}`)}
                    toggle={{
                      label: "Unstage",
                      icon: Minus,
                      run: () => void run("unstage", () => git.unstage(status.root, [file.path])),
                    }}
                    disabled={busy !== null}
                  />
                ))}
              </Section>
            ) : null}

            {changes.length > 0 ? (
              <Section
                label={`Changes (${changes.length})`}
                action={
                  <HeaderButton
                    label="Stage everything"
                    disabled={busy !== null}
                    onClick={() => void run("stage", () => git.stage(status.root, changes.map((f) => f.path)))}
                  >
                    <Plus className="h-3 w-3" />
                  </HeaderButton>
                }
              >
                {changes.map((file) => (
                  <FileRow
                    key={`u:${file.path}`}
                    file={file}
                    letter={file.untracked ? "U" : file.conflicted ? "!" : file.unstaged}
                    diff={open?.key === `u:${file.path}` ? open.text : null}
                    onDiff={() => void toggleDiff(file, false)}
                    onOpen={() => onOpen(`${status.root}/${file.path}`)}
                    toggle={{
                      label: "Stage",
                      icon: Plus,
                      run: () => void run("stage", () => git.stage(status.root, [file.path])),
                    }}
                    disabled={busy !== null}
                  />
                ))}
              </Section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[length:var(--fs-9)]">{children}</span>;
}

function Section({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-border py-1 last:border-b-0">
      <div className="flex items-center px-2 pb-0.5">
        <span className="pane-title min-w-0 flex-1 truncate text-[length:var(--fs-9)]">{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** The colour of a status letter: added green, deleted and conflicted red, the rest amber. */
function letterStyle(letter: string): { className?: string; color?: string } {
  if (letter === "A" || letter === "U" || letter === "?") return { color: "var(--term-green)" };
  if (letter === "D" || letter === "!") return { className: "text-danger" };
  if (letter === "R" || letter === "C") return { className: "text-brand" };
  return { className: "text-warn" };
}

function FileRow({
  file,
  letter,
  diff,
  onDiff,
  onOpen,
  toggle,
  disabled,
}: {
  file: GitFile;
  letter: string;
  diff: string | null;
  onDiff: () => void;
  onOpen: () => void;
  toggle: { label: string; icon: typeof Plus; run: () => void };
  disabled: boolean;
}) {
  const name = baseName(file.path);
  const dir = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));
  const style = letterStyle(letter);
  const Toggle = toggle.icon;
  return (
    <div>
      <div className="group flex items-center gap-1 pr-1 hover:bg-surface-2">
        <button
          type="button"
          onClick={onDiff}
          title={file.orig ? `${file.orig} → ${file.path}` : file.path}
          className="flex min-w-0 flex-1 items-center gap-1 py-[3px] pl-1.5 text-left"
        >
          {diff !== null ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-4" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-4" />
          )}
          <span
            className={cn("w-2.5 shrink-0 text-center font-mono text-[length:var(--fs-10)]", style.className)}
            style={style.color ? { color: style.color } : undefined}
          >
            {letter}
          </span>
          <span className="min-w-0 truncate font-mono text-[length:var(--fs-11)] text-ink-2">{name}</span>
          {dir ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-9)] text-ink-4">{dir}</span>
          ) : null}
        </button>
        <span className="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <HeaderButton label="Open file" onClick={onOpen}>
            <FileText className="h-3 w-3" />
          </HeaderButton>
          <HeaderButton label={toggle.label} disabled={disabled} onClick={toggle.run}>
            <Toggle className="h-3 w-3" />
          </HeaderButton>
        </span>
      </div>
      {diff !== null ? <Diff text={diff} /> : null}
    </div>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="max-h-80 overflow-auto border-y border-border bg-surface-0 py-1 font-mono text-[length:var(--fs-9)] leading-snug">
      {text.split("\n").map((line, index) => {
        const color = line.startsWith("+") && !line.startsWith("+++")
          ? "var(--term-green)"
          : line.startsWith("-") && !line.startsWith("---")
            ? "var(--term-red)"
            : undefined;
        return (
          <div
            key={index}
            className={cn("px-1.5", color === undefined && (line.startsWith("@@") ? "text-brand" : "text-ink-4"))}
            style={color ? { color } : undefined}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

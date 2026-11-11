/**
 * A unified diff, drawn: file headers with their counts, collapsible files,
 * hunk headers, line-number gutters, and a choice of one column or two.
 *
 * Takes parsed files and nothing else — no repository, no git. The diff pane
 * hands it `git diff`; anything that can produce a unified diff and run it
 * through `parseDiff` gets the same view.
 *
 * The one thing it must not do is mount every row. A regenerated lockfile is
 * fifty thousand lines, and fifty thousand rows of grid built in one go is a
 * pane that freezes the window for seconds and then scrolls like syrup. So:
 *
 *   - A file is drawn in chunks of rows, and a chunk is only mounted while it
 *     is near the viewport. Off-screen it is an empty box of the height it had
 *     — or, before it has ever been drawn, of the height its rows would take
 *     unwrapped, which is exact for most and close for the rest.
 *   - Files that are very long, and deleted files, start collapsed: the first
 *     is almost never read line by line and the second is all red. A click
 *     opens either, and which files someone opened or closed survives a
 *     refresh, keyed by both of the file's names.
 *
 * Colours come from the `--diff-*` tokens every theme defines — see
 * `lib/themes.ts` — and the rules in `index.css`.
 */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText } from "lucide-react";

import {
  diffFileKey,
  diffFilePath,
  diffFileSize,
  diffStats,
  splitRows,
  type DiffFile,
  type DiffLine,
} from "@/lib/diff";
import { cn } from "@/lib/utils";

export type DiffLayout = "unified" | "split";

export interface DiffViewProps {
  files: readonly DiffFile[];
  layout: DiffLayout;
  /** Files that would draw more rows than this start collapsed. */
  collapseAbove?: number;
  /** Offer to open a file from its header. Absent, there is no such button. */
  onOpenFile?: (file: DiffFile) => void;
  /** Drawn above the files inside the scroll area — a commit message, say. */
  header?: ReactNode;
  /** Shown instead of the files when there are none. */
  empty?: ReactNode;
  className?: string;
}

/** Rows per separately mounted chunk. Small enough to build in a frame. */
const CHUNK = 120;
/** Matches `line-height` on `.diff-body`, for estimating unmounted heights. */
const ROW_EM = 1.5;
/** How far outside the viewport a chunk is mounted ahead of being scrolled to. */
const MARGIN = "1500px 0px";
const DEFAULT_COLLAPSE_ABOVE = 1500;

/** The scroll area, which every chunk measures its nearness against. */
const ScrollRoot = createContext<HTMLElement | null>(null);

export function DiffView({
  files,
  layout,
  collapseAbove = DEFAULT_COLLAPSE_ABOVE,
  onOpenFile,
  header,
  empty,
  className,
}: DiffViewProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // Only what someone chose is stored; everything else follows the default,
  // so a refresh that brings a new file in gives it the default too.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const collapsedByDefault = useCallback(
    (file: DiffFile) => file.status === "deleted" || diffFileSize(file) > collapseAbove,
    [collapseAbove],
  );
  const isCollapsed = (file: DiffFile) =>
    chosen.get(diffFileKey(file)) ?? collapsedByDefault(file);

  const toggle = useCallback(
    (file: DiffFile) => {
      setChosen((current) => {
        const key = diffFileKey(file);
        const next = new Map(current);
        next.set(key, !(current.get(key) ?? collapsedByDefault(file)));
        return next;
      });
    },
    [collapsedByDefault],
  );

  const setAll = (collapsed: boolean) =>
    setChosen(new Map(files.map((file) => [diffFileKey(file), collapsed])));

  const stats = useMemo(() => diffStats(files), [files]);
  const anyOpen = files.some((file) => !isCollapsed(file));

  return (
    <div
      ref={setRoot}
      className={cn("diff-body h-full w-full overflow-auto bg-surface-0", className)}
    >
      <ScrollRoot.Provider value={root}>
        {header}
        {files.length === 0 ? (
          (empty ?? null)
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-2 py-1 font-sans text-[length:var(--fs-11)] text-ink-3">
              <span>
                {stats.files} {stats.files === 1 ? "file" : "files"} changed
              </span>
              <Counts additions={stats.additions} deletions={stats.deletions} />
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setAll(anyOpen)}
                title={anyOpen ? "Collapse every file" : "Expand every file"}
                className="flex items-center gap-1 rounded-sm px-1 text-ink-3 hover:bg-surface-2 hover:text-ink-1"
              >
                {anyOpen ? (
                  <ChevronsDownUp className="h-3 w-3" />
                ) : (
                  <ChevronsUpDown className="h-3 w-3" />
                )}
                {anyOpen ? "Collapse all" : "Expand all"}
              </button>
            </div>
            {files.map((file) => (
              <FileSection
                key={diffFileKey(file)}
                file={file}
                layout={layout}
                collapsed={isCollapsed(file)}
                onToggle={toggle}
                onOpen={onOpenFile}
              />
            ))}
          </>
        )}
      </ScrollRoot.Provider>
    </div>
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono">
      <span style={{ color: "var(--diff-add)" }}>+{additions}</span>{" "}
      <span style={{ color: "var(--diff-del)" }}>−{deletions}</span>
    </span>
  );
}

const STATUS_LETTER: Record<DiffFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

function statusColor(status: DiffFile["status"]): string | undefined {
  if (status === "added") return "var(--diff-add)";
  if (status === "deleted") return "var(--diff-del)";
  if (status === "renamed" || status === "copied") return "hsl(var(--brand))";
  return "hsl(var(--warn))";
}

const FileSection = memo(function FileSection({
  file,
  layout,
  collapsed,
  onToggle,
  onOpen,
}: {
  file: DiffFile;
  layout: DiffLayout;
  collapsed: boolean;
  onToggle: (file: DiffFile) => void;
  onOpen?: (file: DiffFile) => void;
}) {
  const path = diffFilePath(file);
  const moved =
    (file.status === "renamed" || file.status === "copied") &&
    file.oldPath !== null &&
    file.oldPath !== file.newPath;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <section className="border-b border-border">
      {/* Sticky, so the name of the file being read is always on screen. */}
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-surface-1 px-1.5 py-1 font-sans text-[length:var(--fs-11)]">
        <button
          type="button"
          onClick={() => onToggle(file)}
          aria-expanded={!collapsed}
          title={collapsed ? "Show this file's changes" : "Hide this file's changes"}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Chevron className="h-3 w-3 shrink-0 text-ink-4" />
          <span
            className="w-2.5 shrink-0 text-center font-mono text-[length:var(--fs-10)]"
            style={{ color: statusColor(file.status) }}
            title={file.status}
          >
            {STATUS_LETTER[file.status]}
          </span>
          <span className="min-w-0 truncate font-mono text-ink-1" title={path}>
            {moved ? (
              <>
                <span className="text-ink-3">{file.oldPath}</span>
                <span className="text-ink-4"> → </span>
                {path}
              </>
            ) : (
              path
            )}
          </span>
          {file.similarity !== undefined && moved ? (
            <span className="shrink-0 text-ink-4">{file.similarity}%</span>
          ) : null}
          {file.binary ? <Badge>binary</Badge> : null}
          {file.oldMode && file.newMode && file.oldMode !== file.newMode ? (
            <Badge>
              {file.oldMode} → {file.newMode}
            </Badge>
          ) : null}
        </button>
        <Counts additions={file.additions} deletions={file.deletions} />
        {onOpen && file.newPath !== null ? (
          <button
            type="button"
            onClick={() => onOpen(file)}
            title="Open the file"
            className="shrink-0 rounded-sm p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink-1"
          >
            <FileText className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      {collapsed ? null : <FileBody file={file} layout={layout} />}
    </section>
  );
});

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-hairline-strong px-1 font-mono text-[length:var(--fs-9)] text-ink-3">
      {children}
    </span>
  );
}

/* ── A file's rows ───────────────────────────────────────────────────────── */

type Row =
  | { kind: "hunk"; header: string }
  | { kind: "line"; line: DiffLine }
  | { kind: "pair"; left: DiffLine | null; right: DiffLine | null };

function FileBody({ file, layout }: { file: DiffFile; layout: DiffLayout }) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const hunk of file.hunks) {
      out.push({ kind: "hunk", header: hunk.header });
      if (layout === "split") {
        for (const pair of splitRows(hunk)) out.push({ kind: "pair", ...pair });
      } else {
        for (const line of hunk.lines) out.push({ kind: "line", line });
      }
    }
    return out;
  }, [file, layout]);

  // Wide enough for the largest number in the file, so the gutter does not
  // change width from one chunk to the next.
  const gutter = useMemo(() => {
    let largest = 0;
    for (const hunk of file.hunks) {
      largest = Math.max(largest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
    }
    return `${String(largest).length + 1.5}ch`;
  }, [file]);

  if (rows.length === 0) {
    return (
      <p className="px-3 py-2 font-sans text-[length:var(--fs-11)] text-ink-3">
        {emptyReason(file)}
      </p>
    );
  }

  const chunks: Row[][] = [];
  for (let at = 0; at < rows.length; at += CHUNK) chunks.push(rows.slice(at, at + CHUNK));

  return (
    <div style={{ "--diff-gutter": gutter } as CSSProperties}>
      {chunks.map((chunk, index) => (
        <Chunk key={`${layout}:${index}`} rows={chunk.length}>
          {() => chunk.map((row, at) => <RowView key={at} row={row} />)}
        </Chunk>
      ))}
    </div>
  );
}

/** Why a file has nothing to draw, in words. */
function emptyReason(file: DiffFile): string {
  if (file.combined) return "A merge's combined diff is not shown.";
  if (file.binary) return "Binary file — not shown.";
  if (file.status === "renamed") return "Renamed, with no changes.";
  if (file.status === "copied") return "Copied, with no changes.";
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    return "Only the mode changed.";
  }
  if (file.status === "added") return "An empty file.";
  if (file.status === "deleted") return "An empty file, deleted.";
  return "No textual changes.";
}

/**
 * Rows mounted only while near the viewport.
 *
 * The height an unmounted chunk keeps is the one it measured as it left, so
 * scrolling back over it does not jump. Before it has ever been drawn it is
 * estimated from its row count, which is exact unless something in it wraps.
 */
function Chunk({ rows, children }: { rows: number; children: () => ReactNode }) {
  const root = useContext(ScrollRoot);
  const ref = useRef<HTMLDivElement>(null);
  const measured = useRef<number | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null || root === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && element.childElementCount > 0) {
          measured.current = element.getBoundingClientRect().height;
        }
        setNear(entry.isIntersecting);
      },
      { root, rootMargin: MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  return (
    <div
      ref={ref}
      style={
        near
          ? undefined
          : {
              height:
                measured.current !== null ? `${measured.current}px` : `${rows * ROW_EM}em`,
            }
      }
    >
      {near ? children() : null}
    </div>
  );
}

function RowView({ row }: { row: Row }) {
  if (row.kind === "hunk") {
    return (
      <div
        className="truncate border-y border-border bg-surface-1 px-2 text-ink-3"
        title={row.header}
      >
        {row.header}
      </div>
    );
  }
  if (row.kind === "line") {
    const { line } = row;
    const tone = toneOf(line);
    return (
      <div className="diff-row diff-unified">
        <span className={cn("diff-num", tone)}>{line.oldNo ?? ""}</span>
        <span className={cn("diff-num", tone)}>{line.newNo ?? ""}</span>
        <span className={cn("diff-mark", tone)}>{markOf(line)}</span>
        <LineText line={line} tone={tone} />
      </div>
    );
  }
  return (
    <div className="diff-row diff-split">
      <Side line={row.left} side="old" />
      <Side line={row.right} side="new" />
    </div>
  );
}

function Side({ line, side }: { line: DiffLine | null; side: "old" | "new" }) {
  const gap = side === "new" ? "diff-gap" : undefined;
  if (line === null) {
    return (
      <>
        <span className={cn("diff-num diff-none", gap)} />
        <span className="diff-mark diff-none" />
        <span className="diff-text diff-none" />
      </>
    );
  }
  const tone = toneOf(line);
  return (
    <>
      <span className={cn("diff-num", tone, gap)}>{side === "old" ? line.oldNo : line.newNo}</span>
      <span className={cn("diff-mark", tone)}>{markOf(line)}</span>
      <LineText line={line} tone={tone} />
    </>
  );
}

function LineText({ line, tone }: { line: DiffLine; tone: string | undefined }) {
  return (
    <span className={cn("diff-text", tone)}>
      {line.text || " "}
      {line.noNewline ? (
        <span className="ml-1 select-none text-ink-4" title="No newline at end of file">
          ⊘
        </span>
      ) : null}
    </span>
  );
}

function toneOf(line: DiffLine): string | undefined {
  return line.kind === "add" ? "diff-add" : line.kind === "del" ? "diff-del" : undefined;
}

function markOf(line: DiffLine): string {
  return line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
}

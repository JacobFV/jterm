/**
 * Unified diffs, read into files, hunks and numbered lines.
 *
 * Pure and node-testable on purpose: nothing here knows where the text came
 * from. The diff pane feeds it `git diff` and `git show`; anything else that
 * can produce a unified diff — `gh pr diff`, a `.patch` file — gets the same
 * structure and can be drawn by the same `DiffView`.
 *
 * Two rules carry most of the weight:
 *
 *   - A hunk is read by its *counts*, not by what its lines look like. The
 *     header says how many old and new lines follow, and until both are used
 *     up every line belongs to the hunk. That is the only way to read a deleted
 *     line that itself began `-- `, which would otherwise look like the start
 *     of the next file — a SQL comment, a Lua comment, a Markdown rule.
 *   - Paths are taken from the most specific place git said them: `rename
 *     from`/`to`, then the `---`/`+++` lines, and only failing both the
 *     `diff --git` line, which is ambiguous for a name with a space in it and is
 *     all a binary file or a bare mode change has.
 *
 * Anything not recognised outside a hunk is skipped rather than refused: the
 * header of a commit before its diff, `index` lines, the body of a `GIT binary
 * patch`. A diff cut off at a size cap simply ends early — the last hunk is as
 * long as what arrived.
 */

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading marker. */
  text: string;
  /** Line number on the old side; `null` for an added line. */
  oldNo: number | null;
  /** Line number on the new side; `null` for a deleted line. */
  newNo: number | null;
  /** The file ends here without a final newline — git's `\ No newline…`. */
  noNewline?: boolean;
}

export interface DiffHunk {
  /** The whole `@@ … @@ …` line, as written. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What git printed after the second `@@`: usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffFile {
  /** `null` when the file did not exist before — `/dev/null` on the old side. */
  oldPath: string | null;
  /** `null` when the file does not exist after. */
  newPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  /** Percentage from `similarity index`, for a rename or copy. */
  similarity?: number;
  /** A merge's combined diff (`diff --cc`), whose hunks are not read. */
  combined?: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  // A trailing newline is the end of the last line, not an empty line after it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let file: DiffFile | null = null;
  /** Whether `file` began with `diff --git`, which promises `a/` and `b/`. */
  let git = false;
  /** Whether `file` has had its `---` line, so a second one starts another. */
  let sawOld = false;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const start = (fromGit: boolean): DiffFile => {
    const created: DiffFile = {
      oldPath: null,
      newPath: null,
      status: "modified",
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    files.push(created);
    git = fromGit;
    sawOld = false;
    hunk = null;
    return created;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    // Inside a hunk, the counts decide. Only when both are spent does a line
    // get the chance to be a header.
    if (hunk !== null && file !== null) {
      const current: DiffFile = file;
      const open: DiffHunk = hunk;
      const marker = line[0];
      if (marker === "\\") {
        const last = open.lines[open.lines.length - 1];
        if (last) last.noNewline = true;
        continue;
      }
      if (oldLeft > 0 || newLeft > 0) {
        if (marker === "+" && newLeft > 0) {
          open.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
          newLeft--;
          current.additions++;
          continue;
        }
        if (marker === "-" && oldLeft > 0) {
          open.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
          oldLeft--;
          current.deletions++;
          continue;
        }
        // An empty line is a context line whose trailing space was eaten by
        // whatever carried the diff here — an email client, an editor.
        if ((marker === " " || line === "") && oldLeft > 0 && newLeft > 0) {
          open.lines.push({
            kind: "context",
            text: line.slice(1),
            oldNo: oldNo++,
            newNo: newNo++,
          });
          oldLeft--;
          newLeft--;
          continue;
        }
      }
      // Spent, or a line that cannot be in this hunk: the hunk is over and the
      // line is read again as whatever else it is. A `\` after the last line is
      // handled above, so it still lands on that line.
      hunk = null;
    }

    if (line.startsWith("diff --git ")) {
      const created = (file = start(true));
      const paths = gitHeaderPaths(line.slice("diff --git ".length));
      if (paths) {
        created.oldPath = paths[0];
        created.newPath = paths[1];
      }
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      const created = (file = start(true));
      const path = unquote(line.slice(line.indexOf(" ", 5) + 1));
      created.oldPath = path;
      created.newPath = path;
      created.combined = true;
      continue;
    }

    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      // A `---` with no `diff --git` before it is a plain unified diff, one
      // file per pair. So is a second pair inside one git file, which only a
      // hand-assembled patch would contain.
      const target: DiffFile = file === null || !git || sawOld ? (file = start(false)) : file;
      sawOld = true;
      const before = sidePath(line.slice(4), "a/", git);
      const after = sidePath(lines[index + 1].slice(4), "b/", git);
      // Better than the `diff --git` line, which is ambiguous for a name with a
      // space in it; not as good as `rename from`/`to`, which came first and
      // are left alone. `/dev/null` is authoritative either way.
      const moved = target.status === "renamed" || target.status === "copied";
      if (before === null || !moved) target.oldPath = before;
      if (after === null || !moved) target.newPath = after;
      if (before === null && target.status === "modified") target.status = "added";
      if (after === null && target.status === "modified") target.status = "deleted";
      index++;
      continue;
    }

    if (file === null) continue;
    const current: DiffFile = file;

    const header = HUNK.exec(line);
    if (header) {
      const opened: DiffHunk = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5] ?? "",
        lines: [],
      };
      current.hunks.push(opened);
      hunk = opened;
      oldLeft = opened.oldLines;
      newLeft = opened.newLines;
      oldNo = opened.oldStart;
      newNo = opened.newStart;
      continue;
    }

    if (line.startsWith("new file mode ")) {
      current.status = "added";
      current.oldPath = null;
      current.newMode = line.slice("new file mode ".length).trim();
    } else if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      current.newPath = null;
      current.oldMode = line.slice("deleted file mode ".length).trim();
    } else if (line.startsWith("old mode ")) {
      current.oldMode = line.slice("old mode ".length).trim();
    } else if (line.startsWith("new mode ")) {
      current.newMode = line.slice("new mode ".length).trim();
    } else if (line.startsWith("similarity index ")) {
      const value = parseInt(line.slice("similarity index ".length), 10);
      if (Number.isFinite(value)) current.similarity = value;
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.newPath = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      current.status = "copied";
      current.oldPath = unquote(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      current.status = "copied";
      current.newPath = unquote(line.slice("copy to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
    }
  }

  return files;
}

/* ── Paths ───────────────────────────────────────────────────────────────── */

/**
 * One side of a `---`/`+++` pair: `null` for `/dev/null`, else the path with
 * its `a/`/`b/` prefix taken off when the diff is git's.
 *
 * Git writes a tab after a name that contains a space, and a plain `diff -u`
 * writes one before a timestamp; either way the name is what is before it. A
 * name that itself contains a tab is quoted, so cutting there is safe.
 */
function sidePath(raw: string, prefix: string, git: boolean): string | null {
  let path = raw.startsWith('"') ? unquote(raw) : raw.split("\t")[0];
  if (path === "/dev/null") return null;
  if (git && path.startsWith(prefix)) path = path.slice(prefix.length);
  return path;
}

/**
 * The two paths of `diff --git a/x b/y`.
 *
 * Quoted names are unambiguous. Unquoted ones are not — `a/x b/y b/z` has two
 * readings — so the line is split where it would have to be for both names to
 * be the same, which is every case except a rename, and a rename always has
 * `rename from`/`to` lines that are read instead.
 */
function gitHeaderPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    if (end < 0) return null;
    const first = unquote(rest.slice(0, end + 1));
    const second = unquote(rest.slice(end + 2));
    return [strip(first, "a/"), strip(second, "b/")];
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond >= 0) {
    return [
      strip(rest.slice(0, quotedSecond), "a/"),
      strip(unquote(rest.slice(quotedSecond + 1)), "b/"),
    ];
  }
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const first = rest.slice(0, half);
    const second = rest.slice(half + 1);
    if (rest[half] === " " && first.slice(2) === second.slice(2)) {
      return [strip(first, "a/"), strip(second, "b/")];
    }
  }
  const split = rest.indexOf(" b/");
  if (split < 0) return null;
  return [strip(rest.slice(0, split), "a/"), strip(rest.slice(split + 1), "b/")];
}

function strip(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function closingQuote(text: string): number {
  for (let at = 1; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (text[at] === '"') return at;
  }
  return -1;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A path as git quotes it: C escapes, with every non-ASCII byte as three octal
 * digits. The bytes are collected and decoded as UTF-8 together, because one
 * character of a name is several escapes.
 */
export function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const end = closingQuote(raw);
  const body = raw.slice(1, end < 0 ? raw.length : end);
  const bytes: number[] = [];
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char !== "\\") {
      for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
      continue;
    }
    const next = body[at + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      const octal = body.slice(at + 1, at + 4).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(octal, 8) & 0xff);
      at += octal.length;
    } else if (next !== undefined && next in ESCAPES) {
      bytes.push(ESCAPES[next]);
      at++;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/* ── Reading the result ──────────────────────────────────────────────────── */

/** The name to show for a file: where it ended up, or where it was if it went. */
export function diffFilePath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "";
}

/**
 * A stable identity for a file across re-reads of the same diff, so that which
 * files someone collapsed survives a refresh. Both sides, because a rename and
 * an unrelated edit to the file it replaced are two different entries.
 */
export function diffFileKey(file: DiffFile): string {
  return `${file.oldPath ?? ""}\0${file.newPath ?? ""}`;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export function diffStats(files: readonly DiffFile[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions };
}

/** Lines a file would draw in the unified layout, for deciding what starts collapsed. */
export function diffFileSize(file: DiffFile): number {
  let size = 0;
  for (const hunk of file.hunks) size += hunk.lines.length + 1;
  return size;
}

/** One row of the side-by-side layout. Either side may be empty. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * A hunk laid out side by side.
 *
 * Context lines sit on both sides. A run of deletions followed by a run of
 * additions is the same region rewritten, so the two runs are paired off row
 * by row and the longer one continues alone — the shape every side-by-side
 * viewer uses, and the one that puts a changed line beside its replacement.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      at++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (at < lines.length && lines[at].kind === "del") dels.push(lines[at++]);
    while (at < lines.length && lines[at].kind === "add") adds.push(lines[at++]);
    const length = Math.max(dels.length, adds.length);
    for (let row = 0; row < length; row++) {
      rows.push({ left: dels[row] ?? null, right: adds[row] ?? null });
    }
  }
  return rows;
}

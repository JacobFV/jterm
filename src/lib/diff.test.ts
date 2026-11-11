import { describe, expect, it } from "vitest";

import {
  diffFileKey,
  diffFilePath,
  diffFileSize,
  diffStats,
  parseDiff,
  splitRows,
  unquote,
} from "./diff";

const MODIFIED = `diff --git a/src/main.rs b/src/main.rs
index 1234567..89abcde 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@ fn main() {
 one
-two
+deux
+zwei
 three
 four
@@ -10,2 +11,2 @@
 ten
-eleven
+onze
`;

describe("parseDiff", () => {
  it("reads files, hunks and numbered lines", () => {
    const [file] = parseDiff(MODIFIED);
    expect(file.oldPath).toBe("src/main.rs");
    expect(file.newPath).toBe("src/main.rs");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(2);
    expect(file.hunks).toHaveLength(2);

    const [first, second] = file.hunks;
    expect(first.section).toBe("fn main() {");
    expect([first.oldStart, first.oldLines, first.newStart, first.newLines]).toEqual([1, 4, 1, 5]);
    expect(first.lines.map((line) => [line.kind, line.text, line.oldNo, line.newNo])).toEqual([
      ["context", "one", 1, 1],
      ["del", "two", 2, null],
      ["add", "deux", null, 2],
      ["add", "zwei", null, 3],
      ["context", "three", 3, 4],
      ["context", "four", 4, 5],
    ]);
    expect(second.lines.map((line) => [line.oldNo, line.newNo])).toEqual([
      [10, 11],
      [11, null],
      [null, 12],
    ]);
  });

  it("reads a deleted line that looks like the next file's header", () => {
    // `-- a comment` deleted is `--- a comment`: only the hunk's counts say it
    // is a line and not the start of another file.
    const text = `diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,2 +1,1 @@
--- a comment
+++ not a header either
-select 1;
`;
    // The header claims one new line, and the `+++` line is it.
    const files = parseDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].lines.map((line) => [line.kind, line.text])).toEqual([
      ["del", "-- a comment"],
      ["add", "++ not a header either"],
      ["del", "select 1;"],
    ]);
  });

  it("reads new, deleted and renamed files", () => {
    const text = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index ce01362..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.rs b/new name.rs
similarity index 90%
rename from old name.rs
rename to new name.rs
index 1..2 100644
--- a/old name.rs
+++ b/new name.rs
@@ -1 +1 @@
-a
+b
`;
    const [added, deleted, renamed] = parseDiff(text);
    expect([added.status, added.oldPath, added.newPath, added.newMode]).toEqual([
      "added",
      null,
      "new.txt",
      "100644",
    ]);
    expect(added.hunks[0].lines[0]).toMatchObject({ kind: "add", text: "hello", newNo: 1 });
    expect([deleted.status, deleted.oldPath, deleted.newPath]).toEqual([
      "deleted",
      "gone.txt",
      null,
    ]);
    expect(diffFilePath(deleted)).toBe("gone.txt");
    expect([renamed.status, renamed.oldPath, renamed.newPath, renamed.similarity]).toEqual([
      "renamed",
      "old name.rs",
      "new name.rs",
      90,
    ]);
  });

  it("reads a pure rename and a mode change, which have no hunks at all", () => {
    const text = `diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;
    const [moved, mode] = parseDiff(text);
    expect([moved.status, moved.oldPath, moved.newPath, moved.hunks.length]).toEqual([
      "renamed",
      "a.txt",
      "b.txt",
      0,
    ]);
    expect([mode.oldPath, mode.oldMode, mode.newMode]).toEqual(["run.sh", "100644", "100755"]);
  });

  it("takes a name with a space in it off the git line when nothing else says it", () => {
    const [file] = parseDiff(`diff --git a/a b/c.png b/a b/c.png
index 1..2 100644
Binary files a/a b/c.png and b/a b/c.png differ
`);
    expect(file.binary).toBe(true);
    expect(file.oldPath).toBe("a b/c.png");
    expect(file.newPath).toBe("a b/c.png");
  });

  it("marks binary files, with or without a patch", () => {
    const text = `diff --git a/x.bin b/x.bin
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/x.bin differ
diff --git a/y.bin b/y.bin
index 1..2 100644
GIT binary patch
literal 3
KcmZ?wbN~PQ0RR90

literal 0
HcmV?d00001

`;
    const [x, y] = parseDiff(text);
    expect(x.binary && x.status === "added" && x.newPath === "x.bin").toBe(true);
    expect(y.binary).toBe(true);
    expect(y.hunks).toHaveLength(0);
  });

  it("marks a line that ends the file without a newline", () => {
    const [file] = parseDiff(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
    const [del, add] = file.hunks[0].lines;
    expect(del.noNewline).toBe(true);
    expect(add.noNewline).toBe(true);
    expect(file.hunks[0].lines).toHaveLength(2);
  });

  it("unquotes paths git had to quote, including UTF-8 written as octal", () => {
    const [file] = parseDiff(`diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"
new file mode 100644
--- /dev/null
+++ "b/caf\\303\\251 \\"x\\".txt"
@@ -0,0 +1 @@
+hi
`);
    expect(file.newPath).toBe('café "x".txt');
    expect(unquote('"tab\\there"')).toBe("tab\there");
    expect(unquote("plain")).toBe("plain");
  });

  it("reads a plain unified diff with no git header, timestamps and all", () => {
    const text = `--- old/file.txt\t2024-01-01 00:00:00.000000000 +0000
+++ new/file.txt\t2024-01-02 00:00:00.000000000 +0000
@@ -1 +1 @@
-a
+b
--- other\t2024-01-01
+++ other\t2024-01-02
@@ -1 +1,2 @@
 x
+y
`;
    const files = parseDiff(text);
    expect(files.map((file) => [file.oldPath, file.newPath])).toEqual([
      ["old/file.txt", "new/file.txt"],
      ["other", "other"],
    ]);
    expect(diffStats(files)).toEqual({ files: 2, additions: 2, deletions: 1 });
  });

  it("skips a commit's header before its diff", () => {
    const text = `commit 0123456789abcdef
Author: Someone <s@example.com>

    --- not a header, a commit message

${MODIFIED}`;
    const files = parseDiff(text);
    expect(files).toHaveLength(1);
    expect(files[0].additions).toBe(3);
  });

  it("keeps what arrived of a diff that was cut off mid-hunk", () => {
    const cut = MODIFIED.slice(0, MODIFIED.indexOf("+zwei"));
    const [file] = parseDiff(cut);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines.map((line) => line.text)).toEqual(["one", "two", "deux"]);
  });

  it("treats an empty line inside a hunk as context that lost its space", () => {
    const [file] = parseDiff("--- a\n+++ b\n@@ -1,3 +1,3 @@\n x\n\n-y\n+z\n");
    expect(file.hunks[0].lines.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ["context", 1, 1],
      ["context", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
    ]);
  });

  it("reads nothing out of nothing", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("not a diff at all\n")).toEqual([]);
  });

  it("knows a combined merge diff when it sees one, without reading its hunks", () => {
    const [file] = parseDiff(`diff --cc conflict.txt
index 1,2..3
--- a/conflict.txt
+++ b/conflict.txt
@@@ -1,1 -1,1 +1,1 @@@
- a
 -b
++c
`);
    expect(file.combined).toBe(true);
    expect(file.newPath).toBe("conflict.txt");
    expect(file.hunks).toHaveLength(0);
  });
});

describe("splitRows", () => {
  it("pairs a run of deletions with the additions that replaced it", () => {
    const [file] = parseDiff(MODIFIED);
    const rows = splitRows(file.hunks[0]).map((row) => [
      row.left?.text ?? null,
      row.right?.text ?? null,
    ]);
    expect(rows).toEqual([
      ["one", "one"],
      ["two", "deux"],
      [null, "zwei"],
      ["three", "three"],
      ["four", "four"],
    ]);
  });
});

describe("helpers", () => {
  it("keys a file by both of its names and sizes it by what it draws", () => {
    const [file] = parseDiff(MODIFIED);
    expect(diffFileKey(file)).toBe("src/main.rs\0src/main.rs");
    expect(diffFileSize(file)).toBe(6 + 1 + 3 + 1);
  });
});

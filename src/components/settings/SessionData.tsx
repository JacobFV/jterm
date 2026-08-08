/**
 * Where this app keeps your things, and how to get them out.
 *
 * There is more to explain here than there is to configure, which is why this
 * section is mostly prose. A terminal that quietly records every command you
 * run owes you a plain statement of what it wrote down and where — and a button
 * that opens the folder is a more honest answer than a paragraph describing it.
 *
 * Import is the one destructive thing in the app, and it happens in the wrong
 * window: the workspace being replaced belongs to the *main* window. So the
 * restored snapshot is announced rather than applied, and the window that owns
 * the tabs is the one that acts on it.
 */

import { useEffect, useState } from "react";
import { Download, FolderOpen, Upload } from "lucide-react";

import {
  SESSION_IMPORTED_EVENT,
  dialog,
  emitAll,
  history,
  openPath,
  session,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "./controls";

export function SessionData() {
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    void session.dir().then(setDir);
  }, []);

  const runExport = async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const target = await dialog.save(`jterm-session-${stamp}.jsonl`);
    if (!target) return;
    setBusy("export");
    try {
      const summary = await history.export(target);
      setNote(
        summary
          ? { tone: "ok", text: `Wrote ${summary.lines} records to ${summary.path}` }
          : { tone: "bad", text: "Nothing was written." },
      );
    } catch (error) {
      setNote({ tone: "bad", text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    const source = await dialog.openFiltered("jterm session", ["jsonl"]);
    if (!source) return;
    // Import replaces what is on disk, which is not something to do on a
    // mis-click — this is the one destructive action in the app.
    const sure = await dialog.confirm(
      "Importing replaces the current session — every tab, pane and unsubmitted prompt — with the contents of this file. Continue?",
      "Replace this session?",
    );
    if (!sure) return;

    setBusy("import");
    try {
      const snapshot = await history.import(source);
      if (snapshot) {
        await emitAll(SESSION_IMPORTED_EVENT, snapshot);
        setNote({ tone: "ok", text: "Session restored from the file." });
      } else {
        setNote({ tone: "bad", text: "That file carried no session to restore." });
      }
    } catch (error) {
      setNote({ tone: "bad", text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-[length:var(--fs-125)] leading-relaxed text-ink-2">
          Open tabs, the split layout, notepad buffers and the command typed at every prompt are
          written continuously to <code className="font-mono text-ink-1">session.json</code>. Each
          terminal also keeps its own log —{" "}
          <code className="font-mono text-ink-1">terminals/&lt;pane&gt;.jsonl</code> — with one
          record per line for the shell starting, each command run, the working directory moving,
          and the line you had not submitted. Your preferences are the separate{" "}
          <code className="font-mono text-ink-1">settings.json</code> beside them.
        </p>
        <button
          type="button"
          onClick={() => dir && void openPath(dir)}
          disabled={!dir}
          className="flex w-full items-center gap-2 border border-border bg-surface-1 px-2 py-1.5 text-left font-mono text-[length:var(--fs-11)] text-ink-3 hover:border-hairline-strong hover:text-ink-1 disabled:opacity-50"
        >
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{dir || "…"}</span>
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-[length:var(--fs-125)] leading-relaxed text-ink-2">
          Export folds the layout, every terminal's history, the recorded scrollback and every
          unsubmitted prompt into a single JSONL — one JSON object per line, so it reads with{" "}
          <code className="font-mono text-ink-1">grep</code> and{" "}
          <code className="font-mono text-ink-1">jq</code> like any other log. Import reads one
          back, over the top of the session you have open.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => void runExport()} disabled={busy !== null} className="flex-1">
            <Download className="h-3.5 w-3.5" />
            {busy === "export" ? "Exporting…" : "Export session"}
          </Button>
          <Button onClick={() => void runImport()} disabled={busy !== null} className="flex-1">
            <Upload className="h-3.5 w-3.5" />
            {busy === "import" ? "Importing…" : "Import session"}
          </Button>
        </div>
        {note ? (
          <p
            className={cn(
              "break-all font-mono text-[length:var(--fs-105)]",
              note.tone === "ok" ? "text-ink-3" : "text-danger",
            )}
          >
            {note.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

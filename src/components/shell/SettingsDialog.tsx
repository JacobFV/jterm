/**
 * Settings, which is mostly about the files this app keeps.
 *
 * There is very little to configure and a lot to explain: where the session
 * snapshot lives, that every terminal has its own JSONL beside it, and how to
 * get the lot in and out as one file. A settings panel that shows people where
 * their data is turns out to be more useful here than one full of switches.
 */

import { useEffect, useState } from "react";
import { Download, FolderOpen, Upload, X } from "lucide-react";

import { dialog, history, openPath, session } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  onClose: () => void;
  /** Applied after an import, so the workspace on screen matches the file. */
  onImported: (snapshot: string) => void;
}

export function SettingsDialog({ onClose, onImported }: SettingsDialogProps) {
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    void session.dir().then(setDir);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        onImported(snapshot);
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
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-8 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-full max-w-lg border border-hairline-strong bg-surface-1 shadow-2xl"
      >
        <div className="flex h-9 items-center border-b border-border px-3">
          <span className="pane-title flex-1">Settings</span>
          <button
            type="button"
            title="Close"
            aria-label="Close settings"
            onClick={onClose}
            className="rounded-sm p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-5 p-4">
          <section className="space-y-2">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
              Where your session lives
            </h3>
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              Open tabs, the split layout, notepad buffers and the command typed at every
              prompt are written continuously to <code className="font-mono text-ink-1">session.json</code>.
              Each terminal also keeps its own log —{" "}
              <code className="font-mono text-ink-1">terminals/&lt;pane&gt;.jsonl</code> — with one
              record per line for the shell starting, each command run, the working directory
              moving, and the line you had not submitted.
            </p>
            <button
              type="button"
              onClick={() => dir && void openPath(dir)}
              disabled={!dir}
              className="flex w-full items-center gap-2 border border-border bg-surface-0 px-2 py-1.5 text-left font-mono text-[11px] text-ink-3 hover:border-hairline-strong hover:text-ink-1 disabled:opacity-50"
            >
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{dir || "…"}</span>
            </button>
          </section>

          <section className="space-y-2">
            <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">
              The whole session, as one file
            </h3>
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              Export folds the layout, every terminal's history, the recorded scrollback and
              every unsubmitted prompt into a single JSONL — one JSON object per line, so
              it reads with <code className="font-mono text-ink-1">grep</code> and{" "}
              <code className="font-mono text-ink-1">jq</code> like any other log. Import reads
              one back.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void runExport()}
                disabled={busy !== null}
                className="inline-flex flex-1 items-center justify-center gap-2 border border-hairline-strong bg-surface-2 px-3 py-2 text-[12px] text-ink-1 hover:bg-surface-3 disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                {busy === "export" ? "Exporting…" : "Export session"}
              </button>
              <button
                type="button"
                onClick={() => void runImport()}
                disabled={busy !== null}
                className="inline-flex flex-1 items-center justify-center gap-2 border border-hairline-strong bg-surface-2 px-3 py-2 text-[12px] text-ink-1 hover:bg-surface-3 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {busy === "import" ? "Importing…" : "Import session"}
              </button>
            </div>
            {note ? (
              <p
                className={cn(
                  "break-all font-mono text-[10.5px]",
                  note.tone === "ok" ? "text-ink-3" : "text-danger",
                )}
              >
                {note.text}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

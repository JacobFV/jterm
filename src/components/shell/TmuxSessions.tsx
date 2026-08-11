/**
 * The tmux sessions on this machine, and a way into one.
 *
 * The point of it is the session you did not start from jterm — the `work` you
 * left attached on this machine last week, or the one an ssh session is holding
 * open. jterm cannot recover those with its own snapshot, because the thing
 * that survived is a process rather than a transcript, and attaching is the
 * only way to get it back.
 *
 * A panel rather than a menu item per session: the list has no upper bound, it
 * wants a "new session" field next to it, and sessions come and go while it is
 * open — a menu is the wrong shape for all three.
 *
 * jterm's own per-pane sessions are shown like any other. They are ordinary
 * tmux sessions and hiding them would only make the panel disagree with
 * `tmux ls`, but they are marked, because attaching a second pane to one is a
 * thing you might do deliberately and is confusing if you did not mean it.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Layers, LogOut, Plus, SquareSplitHorizontal, SquareTerminal } from "lucide-react";

import { tmuxControl as controlApi, tmux as tmuxApi, type TmuxSession } from "@/lib/ipc";
import { looksLikeOwnSession } from "@/lib/tmux";
import { cn } from "@/lib/utils";

/**
 * How often the list is re-read while the panel is open.
 *
 * Sessions are created and destroyed by things that are not jterm, so a list
 * read once at open is a list that can be wrong by the time it is clicked.
 */
const REFRESH_MS = 2000;

/** tmux refuses `.` and `:` in a session name; both are targeting syntax. */
function cleanName(raw: string): string {
  return raw.replace(/[.:]/g, "-").trim().slice(0, 64);
}

export function TmuxSessions({
  onAttach,
  onAttachControl,
  onDetach,
  onClose,
}: {
  /** Open one terminal running `tmux attach`, with tmux drawing itself in it. */
  onAttach: (session: string) => void;
  /** Attach in control mode: tmux's windows become tabs, its panes become
   *  jterm's. See `lib/tmuxControl.ts`. */
  onAttachControl: (session: string) => void;
  onDetach: (session: string) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<TmuxSession[] | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  const [fresh, setFresh] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    const read = () => {
      void tmuxApi.sessions().then((list) => {
        if (!disposed) setSessions(list);
      });
      // Which of them jterm is already drawing, so a row offers Detach rather
      // than a second attach that would only fight the first.
      void controlApi.attached().then((list) => {
        if (!disposed) setAttached(list);
      });
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as globalThis.Node)) onClose();
    };
    // Capture, like the menu's: the app's own key handler runs there and would
    // otherwise take Escape before this sees it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const attachFresh = () => {
    const name = cleanName(fresh);
    if (name) onAttachControl(name);
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div
        ref={panelRef}
        role="dialog"
        aria-label="tmux sessions"
        className="flex max-h-[60vh] w-[380px] flex-col border border-hairline-strong bg-surface-2 shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Layers className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          <span className="text-[length:var(--fs-11)] text-ink-2">tmux sessions</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {sessions === null ? (
            <Note>Looking…</Note>
          ) : sessions.length === 0 ? (
            <Note>
              No sessions are running. Naming one below starts it and opens a tab attached to it.
            </Note>
          ) : (
            sessions.map((session) => {
              const live = attached.includes(session.name);
              return (
                <div
                  key={session.name}
                  className="group flex items-center gap-1 px-3 py-1.5 hover:bg-surface-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[length:var(--fs-11)] text-ink-2">
                      {session.name}
                    </div>
                    <div className="text-[length:var(--fs-10)] text-ink-4">
                      {session.windows} {session.windows === 1 ? "window" : "windows"}
                      {live ? " · in this window" : session.attached ? " · attached" : ""}
                      {looksLikeOwnSession(session.name) ? " · jterm" : ""}
                    </div>
                  </div>

                  {live ? (
                    <RowButton
                      label={`Detach from ${session.name}`}
                      onClick={() => onDetach(session.name)}
                    >
                      <LogOut className="h-3.5 w-3.5" />
                    </RowButton>
                  ) : (
                    <>
                      {/* The two ways in, in the order they are usually wanted:
                          tmux's panes as jterm's, or tmux drawn inside one. */}
                      <RowButton
                        label={`Open ${session.name} as jterm panes`}
                        onClick={() => onAttachControl(session.name)}
                      >
                        <SquareSplitHorizontal className="h-3.5 w-3.5" />
                      </RowButton>
                      <RowButton
                        label={`Open ${session.name} in one terminal`}
                        onClick={() => onAttach(session.name)}
                      >
                        <SquareTerminal className="h-3.5 w-3.5" />
                      </RowButton>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        <form
          className="flex items-center gap-1.5 border-t border-border px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            attachFresh();
          }}
        >
          <input
            value={fresh}
            onChange={(event) => setFresh(event.target.value)}
            placeholder="New session name"
            aria-label="New session name"
            autoFocus
            className="min-w-0 flex-1 border border-border bg-surface-1 px-2 py-1 text-[length:var(--fs-11)] text-ink-1 outline-none focus:border-brand"
          />
          <button
            type="submit"
            title="Start this session and open a tab in it"
            disabled={!cleanName(fresh)}
            className={cn(
              "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
              cleanName(fresh) ? "text-ink-2 hover:bg-surface-3 hover:text-ink-1" : "text-ink-4",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-ink-4 opacity-0 hover:bg-surface-2 hover:text-ink-1 focus:opacity-100 group-hover:opacity-100"
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-[length:var(--fs-11)] text-ink-4">{children}</p>;
}

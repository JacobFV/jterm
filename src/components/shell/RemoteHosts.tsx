/**
 * Another machine's terminals, as panes here.
 *
 * Name a host — or press one of the ones this already knows, from
 * `~/.ssh/config` or from an `alias x="ssh …"` in a shell rc — and its tmux
 * sessions are listed. Opening one draws it with jterm's own tabs and splits,
 * over ssh, the same way control mode draws a local session. On a peer that
 * runs jterm itself, every pane over there is a `jterm-…` session, so this list
 * is that machine's panes, labelled by what is running in them.
 *
 * Two ways it can come up short, and each has a way through rather than a dead
 * end. A host ssh cannot reach without asking for a password says why, in ssh's
 * own words; a host without tmux has nothing to draw as panes. Both offer an
 * ordinary terminal running `ssh` — where a password can be typed, and where a
 * machine without tmux is still a shell.
 *
 * The panel stays up while a session is being opened, because that is a
 * connection that can fail and this is the only place with room to say so. It
 * goes when tmux describes the session, which is the moment its tabs appear.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogOut, Plus, Server, SquareSplitHorizontal, SquareTerminal } from "lucide-react";

import {
  listen,
  ssh as sshApi,
  tmuxControl as controlApi,
  TMUX_FAILED_EVENT,
  TMUX_WINDOWS_EVENT,
  type RemoteListing,
  type SshHost,
  type TmuxFailure,
} from "@/lib/ipc";
import {
  isPeerPane,
  loadRecentHosts,
  rememberHost,
  remoteKey,
  sortSessions,
  validHost,
  validRemoteName,
} from "@/lib/remote";
import { orphanLabel } from "@/lib/tmux";
import type { TmuxSessionShape } from "@/lib/tmuxControl";
import { cn } from "@/lib/utils";

/** How often the session list is re-read while it is showing. Slower than the
 *  local picker's: every read is an ssh connection. */
const REFRESH_MS = 5000;

type Listing =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; listing: RemoteListing };

export function RemoteHosts({
  onAttach,
  onDetach,
  onShell,
  onClose,
}: {
  /** Open a control session by its key, `host:name`. */
  onAttach: (key: string) => void;
  onDetach: (key: string) => void;
  /** Open an ordinary terminal running `ssh target`. */
  onShell: (target: string) => void;
  onClose: () => void;
}) {
  const [known, setKnown] = useState<SshHost[]>([]);
  const [typed, setTyped] = useState("");
  const [host, setHost] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing>({ state: "idle" });
  const [attached, setAttached] = useState<string[]>([]);
  const [opening, setOpening] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [fresh, setFresh] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const now = Date.now() / 1000;

  // Known hosts, with the ones used before first — they are the likeliest
  // answer to "which machine". A recent host ssh_config also names is shown
  // once, under the name the user gave it.
  const offered = useMemo(() => {
    const recent = loadRecentHosts();
    const byTarget = new Map(known.map((entry) => [entry.target, entry]));
    const ordered: SshHost[] = recent.map(
      (target) => byTarget.get(target) ?? { name: target, target },
    );
    for (const entry of known) {
      if (!ordered.some((seen) => seen.target === entry.target)) ordered.push(entry);
    }
    return ordered;
  }, [known]);

  useEffect(() => {
    void sshApi.hosts().then(setKnown);
  }, []);

  // The list for the chosen host, kept fresh while it is up.
  useEffect(() => {
    if (host === null) return;
    let disposed = false;
    const read = (first: boolean) => {
      if (first) setListing({ state: "loading" });
      sshApi.tmuxSessions(host).then(
        (result) => {
          if (!disposed) setListing({ state: "ready", listing: result });
        },
        (error: unknown) => {
          // A refresh that fails after a good read keeps the good read: one
          // dropped packet is not a reason to blank a list being looked at.
          if (!disposed && first) setListing({ state: "failed", message: String(error) });
        },
      );
      void controlApi.attached().then((list) => {
        if (!disposed) setAttached(list);
      });
    };
    read(true);
    const timer = setInterval(() => read(false), REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [host]);

  // How an open ends: tmux describing the session (done — the tabs are up),
  // or the backend saying it never got that far.
  useEffect(() => {
    if (opening.length === 0) return;
    const stops: (() => void)[] = [];
    let disposed = false;
    const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
    void listen<TmuxSessionShape>(TMUX_WINDOWS_EVENT, (shape) => {
      if (opening.includes(shape.session)) onClose();
    }).then(keep);
    void listen<TmuxFailure>(TMUX_FAILED_EVENT, (failed) => {
      if (!opening.includes(failed.session)) return;
      setOpening((keys) => keys.filter((key) => key !== failed.session));
      setFailure(failed.message);
    }).then(keep);
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [opening, onClose]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as globalThis.Node)) onClose();
    };
    // Capture, as in the other panels: the app's key handler would take
    // Escape first otherwise.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // Escape steps back to the host list before it closes anything.
      if (host !== null) setHost(null);
      else onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, host]);

  const choose = (target: string) => {
    const clean = target.trim();
    if (!validHost(clean)) return;
    setFailure(null);
    setHost(clean);
  };

  const open = (names: string[]) => {
    if (host === null) return;
    const keys = names.filter(validRemoteName).map((name) => remoteKey(host, name));
    if (keys.length === 0) return;
    rememberHost(host);
    setFailure(null);
    setOpening(keys);
    for (const key of keys) onAttach(key);
  };

  const sessions =
    listing.state === "ready" ? sortSessions(listing.listing.sessions) : [];
  const closed = sessions.filter((session) => !attached.includes(remoteKey(host!, session.name)));
  const nameOf = (target: string) => offered.find((entry) => entry.target === target)?.name;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Remote host"
        className="flex max-h-[60vh] w-[420px] flex-col border border-hairline-strong bg-surface-2 shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Server className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          {host === null ? (
            <span className="text-[length:var(--fs-11)] text-ink-2">Remote host</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setHost(null)}
                className="text-[length:var(--fs-11)] text-ink-3 hover:text-ink-1"
              >
                Remote host
              </button>
              <span className="text-[length:var(--fs-11)] text-ink-4">/</span>
              <span className="truncate text-[length:var(--fs-11)] text-ink-2" title={host}>
                {nameOf(host) ?? host}
              </span>
              {closed.length > 1 ? (
                <button
                  type="button"
                  onClick={() => open(closed.map((session) => session.name))}
                  title="Open every session on this host as jterm tabs"
                  className="ml-auto rounded-sm px-1.5 py-0.5 text-[length:var(--fs-10)] text-ink-3 hover:bg-surface-3 hover:text-ink-1"
                >
                  Open all
                </button>
              ) : null}
            </>
          )}
        </div>

        {host === null ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {offered.length === 0 ? (
                <Note>
                  Type a host below — anything you would give <code>ssh</code>, like{" "}
                  <code>me@10.0.0.7</code> or a name from <code>~/.ssh/config</code>.
                </Note>
              ) : (
                offered.map((entry) => (
                  <button
                    key={entry.target}
                    type="button"
                    onClick={() => choose(entry.target)}
                    className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-3"
                  >
                    <span className="text-[length:var(--fs-11)] text-ink-2">{entry.name}</span>
                    {entry.name !== entry.target ? (
                      <span className="truncate text-[length:var(--fs-10)] text-ink-4">
                        {entry.target}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
            <Field
              value={typed}
              onChange={setTyped}
              placeholder="user@host"
              valid={validHost(typed.trim())}
              title="List this host's tmux sessions"
              onSubmit={() => choose(typed)}
            />
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {failure !== null ? (
                <Problem message={failure} onShell={() => onShell(host)} />
              ) : null}
              {opening.length > 0 && failure === null ? <Note>Connecting…</Note> : null}

              {listing.state === "loading" || listing.state === "idle" ? (
                <Note>Connecting to {host}…</Note>
              ) : listing.state === "failed" ? (
                <Problem message={listing.message} onShell={() => onShell(host)} />
              ) : !listing.listing.tmux ? (
                <Problem
                  message={`${host} has no tmux, so there are no panes to show here.`}
                  onShell={() => onShell(host)}
                />
              ) : sessions.length === 0 ? (
                <Note>No sessions are running there. Naming one below starts it.</Note>
              ) : (
                sessions.map((session) => {
                  const key = remoteKey(host, session.name);
                  const live = attached.includes(key);
                  const openable = validRemoteName(session.name);
                  return (
                    <div
                      key={session.name}
                      className="group flex items-center gap-1 px-3 py-1.5 hover:bg-surface-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[length:var(--fs-11)] text-ink-2">
                          {orphanLabel(session, now)}
                        </div>
                        <div className="truncate text-[length:var(--fs-10)] text-ink-4">
                          {session.name}
                          {isPeerPane(session) ? " · jterm pane" : ""}
                          {session.windows > 1 ? ` · ${session.windows} windows` : ""}
                          {live ? " · open here" : ""}
                        </div>
                      </div>
                      {live ? (
                        <RowButton label="Close these tabs, leaving the session running" onClick={() => onDetach(key)}>
                          <LogOut className="h-3.5 w-3.5" />
                        </RowButton>
                      ) : openable ? (
                        <RowButton
                          label={`Open ${session.name} as jterm panes`}
                          onClick={() => open([session.name])}
                        >
                          <SquareSplitHorizontal className="h-3.5 w-3.5" />
                        </RowButton>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            {listing.state === "ready" && listing.listing.tmux ? (
              <Field
                value={fresh}
                onChange={setFresh}
                placeholder="New session name"
                valid={validRemoteName(cleanName(fresh))}
                title={`Start this session on ${host} and open a tab in it`}
                onSubmit={() => open([cleanName(fresh)])}
              />
            ) : null}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** tmux refuses `.` and `:` in a session name; both are targeting syntax. */
function cleanName(raw: string): string {
  return raw.replace(/[.:]/g, "-").trim().slice(0, 64);
}

function Problem({ message, onShell }: { message: string; onShell: () => void }) {
  return (
    <div className="px-3 py-2">
      <p className="break-words text-[length:var(--fs-11)] text-ink-3">{message}</p>
      <button
        type="button"
        onClick={onShell}
        className="mt-1.5 inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[length:var(--fs-11)] text-ink-2 hover:bg-surface-3 hover:text-ink-1"
      >
        <SquareTerminal className="h-3.5 w-3.5" />
        Open an ssh terminal instead
      </button>
    </div>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  valid,
  title,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  valid: boolean;
  title: string;
  onSubmit: () => void;
}) {
  return (
    <form
      className="flex items-center gap-1.5 border-t border-border px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit();
      }}
    >
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="min-w-0 flex-1 border border-border bg-surface-1 px-2 py-1 text-[length:var(--fs-11)] text-ink-1 outline-none focus:border-brand"
      />
      <button
        type="submit"
        title={title}
        disabled={!valid}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
          valid ? "text-ink-2 hover:bg-surface-3 hover:text-ink-1" : "text-ink-4",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </form>
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
      // Visible without hovering, unlike the local picker's: here opening is
      // the one thing a row is for, and it should not have to be found.
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-surface-2 hover:text-ink-1"
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-[length:var(--fs-11)] text-ink-4">{children}</p>;
}

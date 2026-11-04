/**
 * Another machine's tmux, drawn here as jterm's own tabs and panes.
 *
 * There is almost nothing new on this side, and that is the design. A remote
 * session is a control-mode session like any other (see `lib/tmuxControl.ts`)
 * whose key happens to be `host:name` instead of `name`. The backend runs the
 * control client through ssh when it sees the colon (`src-tauri/src/ssh.rs`);
 * the tabs, the panes, the snapshot and the reattach on launch all carry the
 * key without knowing what is in it.
 *
 * The colon is safe as the separator because tmux will not allow one in a
 * session name, so the last colon is always the boundary and a local key never
 * has one at all. Every snapshot written before this existed means what it
 * meant.
 */

import type { TmuxSession } from "./ipc";
import { looksLikeOwnSession } from "./tmux";

/** The control-session key for `name` on `host`. */
export function remoteKey(host: string, name: string): string {
  return `${host}:${name}`;
}

/** The host and tmux name behind a control-session key; `host` is null for a
 *  session on this machine. Kept in step with `split_key` in `ssh.rs`. */
export function splitKey(key: string): { host: string | null; name: string } {
  const at = key.lastIndexOf(":");
  if (at <= 0) return { host: null, name: key };
  return { host: key.slice(0, at), name: key.slice(at + 1) };
}

/** The same rule as `valid_host` in `ssh.rs`, so the panel can refuse a host
 *  before a round trip rather than after one. */
export function validHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 255 &&
    !host.startsWith("-") &&
    /^[A-Za-z0-9.\-_@]+$/.test(host)
  );
}

/** The same rule as `valid_remote_name`: what can be quoted for the far end. */
export function validRemoteName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && !/['"$`\\!\p{Cc}]/u.test(name);
}

/**
 * The short name a host goes by on a tab: `gb10` for `me@gb10.local`.
 *
 * Tabs are narrow, and the user part and the domain say nothing that tells two
 * of the user's own machines apart.
 */
export function hostLabel(host: string): string {
  const bare = host.slice(host.lastIndexOf("@") + 1);
  // An address is all one name; cutting at its first dot would leave "10".
  if (/^[\d.]+$/.test(bare)) return bare;
  return bare.split(".")[0] || bare;
}

/**
 * A remote session's sessions, in the order worth reading them.
 *
 * Unattached first is wrong here, unlike the orphan menu: on a peer running
 * jterm every one of its panes is a session *with* a client — that jterm — and
 * those are exactly the ones wanted. So this is simply most recent first.
 */
export function sortSessions(sessions: TmuxSession[]): TmuxSession[] {
  return [...sessions].sort((a, b) => b.activity - a.activity || a.name.localeCompare(b.name));
}

/**
 * Whether a remote session is one of a peer jterm's panes.
 *
 * The same weak test as for local sessions, and used the same way: to label a
 * row, never to decide anything.
 */
export function isPeerPane(session: TmuxSession): boolean {
  return looksLikeOwnSession(session.name);
}

/* ── Hosts used before ───────────────────────────────────────────────────── */

const RECENT_KEY = "jterm.remoteHosts";
const MAX_RECENT = 8;

/**
 * The hosts connected to before, most recent first.
 *
 * A per-window convenience — the list the panel opens on — so browser storage
 * is the right place and the settings file is not: losing it costs one typed
 * host name. Decoded like anything else read back from storage, entry by entry,
 * so one bad value is dropped rather than costing the list.
 */
export function decodeRecentHosts(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hosts: string[] = [];
  for (const value of parsed) {
    if (typeof value === "string" && validHost(value) && !hosts.includes(value)) hosts.push(value);
    if (hosts.length === MAX_RECENT) break;
  }
  return hosts;
}

export function withRecentHost(hosts: string[], host: string): string[] {
  return [host, ...hosts.filter((known) => known !== host)].slice(0, MAX_RECENT);
}

export function loadRecentHosts(): string[] {
  try {
    return decodeRecentHosts(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function rememberHost(host: string): void {
  try {
    const next = withRecentHost(loadRecentHosts(), host);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage refused — a private window, a full quota. The host still works;
    // it just is not offered next time.
  }
}

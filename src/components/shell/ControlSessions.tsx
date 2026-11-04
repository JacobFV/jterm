/**
 * What the chrome needs to know about control-mode sessions, without every
 * component in between being handed it.
 *
 * Two things: which remote sessions have lost their connection (so their tabs
 * and panes can say so, and stop taking input), and the two things a person can
 * do about a session from a tab or a pane header — detach from it, or try the
 * connection again now rather than at the next retry.
 *
 * A context rather than props because the readers are three levels apart — the
 * tab strip, a pane's header, and the cover over a disconnected pane — and the
 * layers between them have no business with tmux.
 */

import { createContext, useContext, useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

import { hostLabel, splitKey } from "@/lib/remote";
import type { PaneState, Tab } from "@/state/workspace";

export interface LostSession {
  /** When the next attempt is due, in epoch ms — for the countdown. */
  retryAt: number;
  /** Whether an attempt is in flight right now. */
  trying: boolean;
}

export interface ControlSessionsValue {
  lost: ReadonlyMap<string, LostSession>;
  detach: (key: string) => void;
  reconnect: (key: string) => void;
}

const ControlSessionsContext = createContext<ControlSessionsValue>({
  lost: new Map(),
  detach: () => {},
  reconnect: () => {},
});

export const ControlSessionsProvider = ControlSessionsContext.Provider;

export function useControlSessions(): ControlSessionsValue {
  return useContext(ControlSessionsContext);
}

/** The control session a pane is drawn from, or null for any other pane. */
export function controlKeyOf(pane: PaneState | undefined): string | null {
  if (pane?.kind !== "terminal" || pane.tmuxPane === undefined || !pane.tmux) return null;
  return pane.tmux;
}

/** The control session a tab's windows come from, or null. */
export function controlKeyOfTab(tab: Tab): string | null {
  for (const pane of Object.values(tab.panes)) {
    const key = controlKeyOf(pane);
    if (key !== null) return key;
  }
  return null;
}

/** "gb10" for a remote session, "tmux" for a local one — what to detach from. */
export function sessionPlace(key: string): string {
  const { host } = splitKey(key);
  return host === null ? "tmux" : hostLabel(host);
}

/**
 * The cover over a pane whose connection is down.
 *
 * It takes the pointer, so nothing behind it can be clicked or selected into a
 * shell that is not there; keystrokes already go nowhere (the backend swallows
 * them). The screen underneath stays visible, dimmed, because the last thing
 * the pane showed is often exactly what someone needs while waiting.
 */
export function DisconnectedCover({ sessionKey, state }: { sessionKey: string; state: LostSession }) {
  const { detach, reconnect } = useControlSessions();
  // Ticks the countdown. Only while a cover is up, which is only while a
  // connection is down, so this is not a timer anyone pays for normally.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-surface-0/70 backdrop-blur-[1px]"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-col items-center gap-2 border border-hairline-strong bg-surface-2 px-4 py-3 text-center shadow-lg">
        <div className="flex items-center gap-2 text-[length:var(--fs-11)] text-ink-2">
          <WifiOff className="h-3.5 w-3.5 text-ink-3" />
          Disconnected from {sessionPlace(sessionKey)}
        </div>
        <div className="text-[length:var(--fs-10)] text-ink-4">
          {state.trying ? "Reconnecting…" : `Trying again in ${seconds}s`} · the session is still
          running there
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={state.trying}
            onClick={() => reconnect(sessionKey)}
            className="rounded-sm border border-border px-2 py-0.5 text-[length:var(--fs-11)] text-ink-2 hover:bg-surface-3 hover:text-ink-1 disabled:opacity-50"
          >
            Reconnect now
          </button>
          <button
            type="button"
            onClick={() => detach(sessionKey)}
            className="rounded-sm px-2 py-0.5 text-[length:var(--fs-11)] text-ink-3 hover:bg-surface-3 hover:text-ink-1"
          >
            Close these tabs
          </button>
        </div>
      </div>
    </div>
  );
}

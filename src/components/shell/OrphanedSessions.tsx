/**
 * The tmux sessions that outlived their pane, one press from the titlebar.
 *
 * jterm keeps a pane's shell in tmux so that quitting does not cost the work,
 * and the price of that is that a session can be left behind: an extra window
 * closed for good, a pane closed while tmux was not answering. Nothing on
 * screen then says that a dev server or an agent is still running in it, and
 * the first anyone hears of it is a port that is mysteriously taken. This
 * menu is where those sessions are seen, and taken back or ended.
 *
 * In the titlebar rather than under the new-tab button, where the full session
 * picker lives, because the point is to be noticed: the button carries a count
 * whenever there is something to find. The picker is for going looking.
 */

import { useEffect, useState } from "react";
import { Ghost, SquareSplitHorizontal, SquareTerminal, Trash2 } from "lucide-react";

import { tmux as tmuxApi, type TmuxSession } from "@/lib/ipc";
import { looksLikeOwnSession, orphanLabel, orphanedSessions } from "@/lib/tmux";
import { cn } from "@/lib/utils";
import { Menu, MenuHeading, MenuItem, MenuSubmenu, useMenu } from "./Menu";

/**
 * How often the count is re-read with the menu closed, and with it open.
 *
 * Closed, it only has to be right by the time someone glances up; one
 * `list-sessions` every quarter minute is nothing. Open, a row may be acted on,
 * so it is kept as fresh as the session picker keeps its list.
 */
const IDLE_REFRESH_MS = 15_000;
const OPEN_REFRESH_MS = 2_000;

export interface OrphanActions {
  /** Take the session back as jterm panes, through control mode. */
  attachControl: (session: string) => void;
  /** Open one terminal with tmux drawing the session inside it. */
  attach: (session: string) => void;
}

export function OrphanedSessions({ actions }: { actions: OrphanActions }) {
  const menu = useMenu();
  const [orphans, setOrphans] = useState<TmuxSession[]>([]);
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    let disposed = false;
    const read = () => {
      void tmuxApi.sessions().then((list) => {
        if (disposed) return;
        setOrphans(orphanedSessions(list));
        setNow(Date.now() / 1000);
      });
    };
    read();
    const timer = setInterval(read, menu.open ? OPEN_REFRESH_MS : IDLE_REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [menu.open]);

  const act = (run: () => void) => {
    menu.close();
    run();
  };

  const end = (name: string) => {
    menu.close();
    // Read again straight after, so the count does not go on claiming a
    // session that is gone until the next quarter-minute tick.
    void tmuxApi.killSession(name).then(() =>
      tmuxApi.sessions().then((list) => setOrphans(orphanedSessions(list))),
    );
  };

  const count = orphans.length;
  const label =
    count === 0
      ? "Orphaned tmux sessions — none"
      : `${count} orphaned tmux ${count === 1 ? "session" : "sessions"}`;

  return (
    <div ref={menu.wrapRef} className="relative flex items-center">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        className={cn(
          "relative inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-surface-2",
          menu.open
            ? "text-ink-1"
            : count > 0
              ? "text-ink-2 hover:text-ink-1"
              : "text-ink-4 hover:text-ink-1",
        )}
      >
        <Ghost className="h-3.5 w-3.5" />
        {count > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 min-w-[12px] rounded-full bg-brand px-[3px] text-center text-[9px] leading-[12px] text-surface-1">
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>

      <Menu menu={menu}>
        <MenuHeading>Orphaned tmux sessions</MenuHeading>
        {count === 0 ? (
          <p className="px-3 py-1.5 text-[length:var(--fs-11)] text-ink-4">
            None. Every session has a pane looking at it.
          </p>
        ) : (
          orphans.map((session) => (
            <MenuSubmenu
              key={session.name}
              icon={looksLikeOwnSession(session.name) ? SquareTerminal : Ghost}
              label={orphanLabel(session, now)}
            >
              <MenuHeading>{session.name}</MenuHeading>
              <MenuItem
                icon={SquareSplitHorizontal}
                label="Open as jterm panes"
                onSelect={() => act(() => actions.attachControl(session.name))}
              />
              <MenuItem
                icon={SquareTerminal}
                label="Open in one terminal"
                onSelect={() => act(() => actions.attach(session.name))}
              />
              <MenuItem
                icon={Trash2}
                label="End session"
                onSelect={() => end(session.name)}
              />
            </MenuSubmenu>
          ))
        )}
      </Menu>
    </div>
  );
}

/**
 * The left sidebar: four tools about the directory the focused terminal is in,
 * shown one at a time and switched from the chevron at the top left.
 *
 *   - **Files** — that directory as a tree. See `FileTree`.
 *   - **Search** — text in the files under it. See `SidebarSearch`.
 *   - **Git** — the repository it is in. See `SidebarGit`.
 *   - **Agent** — an agent CLI working in it, wired to jterm. See `SidebarAgent`.
 *
 * Every tab that has been shown stays mounted, and switching or closing hides
 * rather than unmounts. For the agent that is the rule panes live by: it is a
 * process with a conversation in it, and a layout change must never be what
 * ends it. For the others it is what keeps them quick — the tree opens showing
 * what it had, and a search keeps its query and results when you look away and
 * back. A tab is only mounted the first time it is shown, so a window that
 * never opens the agent never starts one.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Bot, ChevronDown, Folder, GitBranch, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SidebarTab } from "@/state/workspace";
import { FileTree } from "./FileTree";
import { Menu, MenuItem, useMenu, type MenuIcon } from "./Menu";
import { SidebarAgent } from "./SidebarAgent";
import { SidebarNote } from "./SidebarChrome";
import { SidebarGit } from "./SidebarGit";
import { SidebarSearch } from "./SidebarSearch";

const TABS: { id: SidebarTab; label: string; icon: MenuIcon }[] = [
  { id: "files", label: "Files", icon: Folder },
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "agent", label: "Agent", icon: Bot },
];

interface SidebarProps {
  /** The directory everything here is about. `null` until one is known. */
  root: string | null;
  /** False while the sidebar is closed. */
  visible: boolean;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  onOpen: (path: string) => void;
  /** The window's theme; see `SidebarAgent`. */
  theme: string;
}

export function Sidebar({ root, visible, tab, onTab, onOpen, theme }: SidebarProps) {
  const [shown, setShown] = useState<ReadonlySet<SidebarTab>>(() => new Set(["files"]));
  useEffect(() => {
    if (!visible || shown.has(tab)) return;
    setShown(new Set([...shown, tab]));
  }, [visible, tab, shown]);

  const switcher = <Switcher tab={tab} onTab={onTab} />;

  // Four fixed slots in a fixed order, each hidden unless it is the tab. A slot
  // that has not been shown yet is empty rather than absent, so no tab's
  // component ever changes position in the tree — which is what would remount
  // it.
  const slot = (id: SidebarTab, content: ReactNode) => (
    <div className={cn("h-full w-full", tab !== id && "hidden")}>{content}</div>
  );

  return (
    <div className="h-full w-full">
      {slot(
        "files",
        root ? (
          <FileTree
            root={root}
            visible={visible && tab === "files"}
            onOpen={onOpen}
            switcher={switcher}
          />
        ) : (
          <Waiting switcher={switcher} />
        ),
      )}
      {slot(
        "search",
        shown.has("search") && root ? (
          <SidebarSearch
            root={root}
            active={visible && tab === "search"}
            onOpen={onOpen}
            switcher={switcher}
          />
        ) : null,
      )}
      {slot(
        "git",
        shown.has("git") && root ? (
          <SidebarGit cwd={root} active={visible && tab === "git"} onOpen={onOpen} switcher={switcher} />
        ) : null,
      )}
      {slot(
        "agent",
        shown.has("agent") && root ? (
          <SidebarAgent
            cwd={root}
            active={visible && tab === "agent"}
            theme={theme}
            switcher={switcher}
          />
        ) : null,
      )}
    </div>
  );
}

/** The chevron in the corner, and the menu of tabs it opens. */
function Switcher({ tab, onTab }: { tab: SidebarTab; onTab: (tab: SidebarTab) => void }) {
  const menu = useMenu();
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0];
  return (
    <div ref={menu.wrapRef} className="shrink-0">
      <button
        type="button"
        title={`${current.label} — switch sidebar tab`}
        aria-label={`${current.label}: switch sidebar tab`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        className={cn(
          "rounded-sm p-1 hover:bg-surface-2 hover:text-ink-1",
          menu.open ? "bg-surface-2 text-ink-1" : "text-ink-4",
        )}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      <Menu menu={menu}>
        {TABS.map((entry) => (
          <MenuItem
            key={entry.id}
            icon={entry.icon}
            label={entry.label}
            selected={entry.id === tab}
            onSelect={() => {
              menu.close();
              onTab(entry.id);
            }}
          />
        ))}
      </Menu>
    </div>
  );
}

function Waiting({ switcher }: { switcher: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1.5">
        {switcher}
      </div>
      <SidebarNote>reading…</SidebarNote>
    </div>
  );
}

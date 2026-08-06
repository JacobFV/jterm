/**
 * The left sidebar: the focused terminal's working directory, as a tree.
 *
 * Rooted on wherever the focused shell currently is, so `cd` moves the tree
 * with you. That is the whole reason it is worth having next to a terminal
 * rather than being a file manager — it answers "what is in here" for the here
 * you are already in.
 *
 * Directories load when they are opened and are then remembered, so walking
 * back up a tree you have already been down costs nothing. Nothing is watched:
 * a file created by the shell will not appear until the directory is collapsed
 * and reopened, or Refresh is pressed. Watching every open directory would mean
 * an inotify handle per node for a payoff most sessions never notice, and the
 * refresh button is one click.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Eye,
  EyeOff,
  Folder,
  RotateCw,
} from "lucide-react";

import { fs, type DirEntry } from "@/lib/ipc";
import { kindForPath } from "@/lib/filetypes";
import { cn } from "@/lib/utils";
import { paneKind } from "@/panes/registry";

interface FileTreeProps {
  /** Where to root the tree — the focused terminal's cwd. */
  root: string;
  onOpen: (path: string) => void;
  onRootChange: (path: string) => void;
}

export function FileTree({ root, onOpen, onRootChange }: FileTreeProps) {
  const [showHidden, setShowHidden] = useState(false);
  // Keyed by directory path. Absent means "never opened"; an empty array is a
  // directory that is genuinely empty, which must look different from pending.
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});

  const load = useCallback(async (path: string) => {
    try {
      const entries = await fs.list(path);
      setChildren((current) => ({ ...current, [path]: entries }));
      setFailed((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    } catch (error) {
      setFailed((current) => ({ ...current, [path]: String(error) }));
    }
  }, []);

  // A new root is a different tree: everything remembered about the old one is
  // dropped rather than left to accumulate across every `cd` of a long session.
  useEffect(() => {
    setChildren({});
    setOpen({});
    setFailed({});
    void load(root);
  }, [root, load]);

  const toggle = (path: string) => {
    setOpen((current) => {
      const next = !current[path];
      if (next && !(path in children)) void load(path);
      return { ...current, [path]: next };
    });
  };

  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <button
          type="button"
          title="Go up one directory"
          aria-label="Go up one directory"
          onClick={() => void fs.parent(root).then((parent) => parent && onRootChange(parent))}
          className="shrink-0 rounded-sm p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
        >
          <CornerLeftUp className="h-3 w-3" />
        </button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-2"
          title={root}
        >
          {rootName}
        </span>
        <button
          type="button"
          title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          onClick={() => setShowHidden((value) => !value)}
          className="shrink-0 rounded-sm p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
        >
          {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        </button>
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => {
            // Only what is on screen: re-reading every directory ever opened
            // would hit the disk once per node for no visible gain.
            setChildren({});
            void load(root);
            for (const [path, isOpen] of Object.entries(open)) {
              if (isOpen) void load(path);
            }
          }}
          className="shrink-0 rounded-sm p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
        >
          <RotateCw className="h-3 w-3" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        <Level
          path={root}
          depth={0}
          showHidden={showHidden}
          children_={children}
          open={open}
          failed={failed}
          onToggle={toggle}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

interface LevelProps {
  path: string;
  depth: number;
  showHidden: boolean;
  // `children` is taken by React; the trailing underscore keeps this from
  // shadowing it in a component's props.
  children_: Record<string, DirEntry[]>;
  open: Record<string, boolean>;
  failed: Record<string, string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}

function Level({ path, depth, showHidden, children_, open, failed, onToggle, onOpen }: LevelProps) {
  const entries = children_[path];

  if (failed[path]) {
    return (
      <p
        className="px-2 py-1 font-mono text-[10px] text-danger"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {failed[path].replace(/^Error:\s*/, "")}
      </p>
    );
  }

  if (entries === undefined) {
    return (
      <p
        className="px-2 py-1 font-mono text-[10px] text-ink-4"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        reading…
      </p>
    );
  }

  const visible = showHidden ? entries : entries.filter((entry) => !entry.hidden);

  if (visible.length === 0) {
    return (
      <p
        className="px-2 py-1 font-mono text-[10px] text-ink-4"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        empty
      </p>
    );
  }

  return (
    <>
      {visible.map((entry) => {
        const isOpen = open[entry.path] === true;
        // A file's row carries the icon of the pane that would open it, which
        // is the only preview available before the click.
        const Icon = entry.isDir ? Folder : paneKind(kindForPath(entry.path)).icon;
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => (entry.isDir ? onToggle(entry.path) : onOpen(entry.path))}
              title={entry.path}
              className={cn(
                "flex w-full items-center gap-1 py-[3px] pr-2 text-left",
                "hover:bg-surface-2",
                entry.hidden && "opacity-60",
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              <span className="flex h-3 w-3 shrink-0 items-center justify-center text-ink-4">
                {entry.isDir ? (
                  isOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )
                ) : null}
              </span>
              <Icon
                className={cn("h-3 w-3 shrink-0", entry.isDir ? "text-ink-3" : "text-ink-4")}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
                {entry.name}
              </span>
            </button>

            {entry.isDir && isOpen ? (
              <Level
                path={entry.path}
                depth={depth + 1}
                showHidden={showHidden}
                children_={children_}
                open={open}
                failed={failed}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

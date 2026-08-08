/**
 * The open tabs and — since the window has no OS decorations — the titlebar.
 *
 * Merging the two is what makes the app feel like a window rather than a page
 * in a frame, and it raises the stakes on this row: it is always the topmost
 * thing on screen, so nothing in it may be scrolled away from or covered.
 *
 * Dragging: `data-tauri-drag-region` goes on the strip's own background and on
 * the explicit spacer, never on a tab or a button. An element carrying the
 * attribute swallows the press in order to move the window, so putting it on an
 * interactive child would make that child unclickable.
 *
 * A tab drag means two different things depending on where the pointer goes.
 * Kept inside the strip it reorders, live, as every browser does. Taken below
 * the strip it becomes an offer to graft the tab into the workspace as a split
 * — the strip stops reordering and starts reporting the pointer upwards, and
 * `Workspace` decides which pane and which edge that lands on, since it is the
 * one that knows where the panes are.
 */

import { useEffect, useRef, useState } from "react";
import { PanelLeft, Plus, Settings as SettingsIcon, X } from "lucide-react";

import { MACOS_TRAFFIC_LIGHT_INSET_PX, usesNativeWindowChrome } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { NEW_PANE_MENU } from "@/panes/registry";
import { type PaneKind, type Tab, focusedPane, tabLabel } from "@/state/workspace";
import { Menu, MenuItem, useMenu } from "./Menu";
import { PaneMenu, type PaneMenuActions } from "./PaneMenu";
import type { TabDrag } from "./Workspace";
import { WindowControls } from "./WindowControls";

/** Movement before a press on a tab counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** How long the new-tab button must be held before it offers the other kinds. */
const LONG_PRESS_MS = 400;

/**
 * Bare strip kept to the left of the first tab, purely to grab the window by.
 *
 * With a tab hard against the corner there is nowhere left to pick the window
 * up from except the thin gap above it. On macOS this is *added to* the traffic
 * light inset rather than replacing it, because that region belongs to the
 * system buttons and clicking near them should not be a gamble.
 */
const WINDOW_GRAB_INSET_PX = 14;

interface TabStripProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: (kind: PaneKind) => void;
  /** Show the file chooser and open whatever comes back. */
  onOpenFile: () => void;
  onReorder: (tabId: string, toIndex: number) => void;
  /** What a tab's kind icon offers — the same menu a split pane's header has,
   *  aimed at whichever pane that tab is focused on. It lives here too because
   *  a tab holding one pane draws no header of its own. */
  paneMenu: PaneMenuActions;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  /** Where a tab dragged below the strip currently is, or `null` when the
   *  gesture is over or has come back inside the strip. */
  onDragOverWorkspace: (drag: TabDrag | null) => void;
  /** Released over the workspace. True if the tab was actually grafted in —
   *  in which case it no longer exists and must not then be selected. */
  onDropInWorkspace: (tabId: string) => boolean;
}

export function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onOpenFile,
  onReorder,
  paneMenu,
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
  onDragOverWorkspace,
  onDropInWorkspace,
}: TabStripProps) {
  // macOS keeps its native traffic lights, which float over the top-left of the
  // webview. Without this the first tab sits underneath them.
  const [leadingInset, setLeadingInset] = useState(0);
  useEffect(() => {
    setLeadingInset(
      (usesNativeWindowChrome() ? MACOS_TRAFFIC_LIGHT_INSET_PX : 0) + WINDOW_GRAB_INSET_PX,
    );
  }, []);

  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /**
   * Set when a drag ended by grafting the tab into the workspace.
   *
   * A release still produces a `click` on the tab, and that click would select
   * a tab that the graft has just dissolved — leaving `activeTabId` pointing at
   * nothing and the window blank. So the next click is swallowed.
   */
  const suppressClick = useRef(false);

  const beginTabDrag = (tabId: string) => (event: React.PointerEvent) => {
    // Cleared here rather than only when a click consumes it. A release with
    // pointer capture held does not always produce a click, and a flag left
    // standing would swallow the first click of whatever gesture came next.
    suppressClick.current = false;
    if (event.button !== 0) return;
    const origin = { x: event.clientX, y: event.clientY };
    const node = event.currentTarget as HTMLElement;
    let armed = false;
    let overWorkspace = false;

    // Listened for on the window rather than on the tab. Until the drag arms
    // there is no pointer capture, so a movement that leaves the tab before it
    // has travelled the threshold — a flick towards the workspace, or simply a
    // quick hand — would otherwise be delivered to whatever is now under the
    // pointer and the gesture would never start at all.
    const move = (moveEvent: PointerEvent) => {
      if (!armed) {
        // Both axes: a tab dragged straight down towards the workspace has not
        // moved sideways at all, and would otherwise never arm.
        if (
          Math.abs(moveEvent.clientX - origin.x) < DRAG_THRESHOLD_PX &&
          Math.abs(moveEvent.clientY - origin.y) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        armed = true;
        node.setPointerCapture(moveEvent.pointerId);
        setDragging(tabId);
      }

      // Below the strip the gesture stops being about tab order.
      const bottom = stripRef.current?.getBoundingClientRect().bottom ?? 0;
      if (moveEvent.clientY > bottom) {
        overWorkspace = true;
        onDragOverWorkspace({ tabId, x: moveEvent.clientX, y: moveEvent.clientY });
        return;
      }
      if (overWorkspace) {
        overWorkspace = false;
        onDragOverWorkspace(null);
      }

      // Reorder live: the tab under the pointer trades places with this one, so
      // the strip always shows the order a release would commit to.
      const over = tabs.findIndex((tab) => {
        const element = tabRefs.current.get(tab.id);
        if (!element) return false;
        const bounds = element.getBoundingClientRect();
        return moveEvent.clientX >= bounds.left && moveEvent.clientX <= bounds.right;
      });
      if (over >= 0 && tabs[over].id !== tabId) onReorder(tabId, over);
    };

    const finish = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (armed) node.releasePointerCapture(upEvent.pointerId);
      setDragging(null);

      if (overWorkspace) {
        // Cancels rather than drops: a pointer that was taken away rather than
        // released is not a decision.
        const dropped = upEvent.type === "pointerup" && onDropInWorkspace(tabId);
        onDragOverWorkspace(null);
        if (dropped) suppressClick.current = true;
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    // `select-none` and the default cursor because this row is chrome: dragging
    // the window must not paint a text selection across the tabs.
    <div
      ref={stripRef}
      data-tauri-drag-region
      className="relative z-40 flex h-head shrink-0 cursor-default select-none items-stretch border-b border-border bg-surface-1"
    >
      {/* Room for the macOS traffic lights, plus a bare strip on every platform
          that exists only to be grabbed. Draggable, so the area around the
          system buttons still moves the window. */}
      <div data-tauri-drag-region className="shrink-0" style={{ width: leadingInset }} />

      {/* Takes all the room left over by the window controls, so the tabs have
          something to spread into. The drag spacer below shares this box rather
          than sitting outside it, which is what lets tabs grow first and the
          window's drag handle take only what is genuinely spare. */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const pane = focusedPane(tab);
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              onPointerDown={beginTabDrag(tab.id)}
              className={cn(
                // Chrome's sizing rule, and the one people expect: tabs share
                // the strip evenly, widening to a comfortable maximum when
                // there are few and narrowing to a legible minimum as more
                // open. Only once they are all at the minimum does the strip
                // scroll — a basis of `auto` here would leave every tab at its
                // text width and start scrolling with the bar half empty.
                "group flex min-w-[112px] max-w-[240px] flex-1 basis-0 items-center gap-1.5 border-r border-border px-2.5",
                isActive
                  ? "bg-surface-0 shadow-[inset_0_-2px_0_hsl(var(--brand))]"
                  : "hover:bg-surface-2",
                dragging === tab.id && "opacity-60",
              )}
            >
              {/* Outside the select button rather than in it: it is a control
                  of its own, and a button inside a button is neither valid nor
                  clickable. */}
              {pane ? (
                <PaneMenu
                  tabs={tabs}
                  tabId={tab.id}
                  pane={pane}
                  actions={paneMenu}
                  muted={!isActive}
                />
              ) : null}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center text-left"
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelect(tab.id);
                }}
                aria-current={isActive}
                title={tabLabel(tab)}
              >
                <span
                  className={cn("truncate text-[length:var(--fs-11)]", isActive ? "text-ink-1" : "text-ink-3")}
                >
                  {tabLabel(tab)}
                </span>
              </button>
              {/* The active tab's close control is always visible rather than
                  waiting for a hover, since it is the one most likely wanted. */}
              <button
                type="button"
                title="Close tab"
                aria-label={`Close ${tabLabel(tab)}`}
                className={cn(
                  "shrink-0 rounded-sm p-0.5 text-ink-4 hover:text-ink-1 group-hover:opacity-100",
                  isActive ? "opacity-100" : "opacity-0",
                )}
                onClick={() => onClose(tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {/* Left gravity: the new-tab control sits against the rightmost tab and
            travels with it, rather than parking at the far edge of the strip. */}
        <NewTabButton onNew={onNew} onOpenFile={onOpenFile} />

        {/* The window's drag handle, and where a double-click toggles maximise —
            which Tauri wires to the drag region for us. Zero-basis, so it only
            ever claims space the tabs did not want. */}
        <div data-tauri-drag-region className="min-w-0 flex-1 basis-0" />
      </div>

      {/* App chrome, stacked with the window buttons at the right end. Naked —
          no border, no fill — so they read as part of the titlebar rather than
          as a toolbar that happens to live in it. */}
      <div className="flex shrink-0 items-center gap-0.5 pl-1 pr-1">
        <ChromeButton
          label={sidebarOpen ? "Hide the file tree" : "Show the file tree"}
          active={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton label="Settings" onClick={onOpenSettings}>
          <SettingsIcon className="h-3.5 w-3.5" />
        </ChromeButton>
      </div>

      <WindowControls />
    </div>
  );
}

function ChromeButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-sm",
        active ? "text-brand" : "text-ink-4 hover:text-ink-1",
        "hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

/**
 * New tab, with the other pane kinds one press away.
 *
 * A click opens a terminal, because that is what nearly every new tab is meant
 * to be. Holding the button — or right-clicking it — offers the rest, which
 * keeps the common case a single click without hiding the others behind a menu
 * nobody would find.
 */
function NewTabButton({
  onNew,
  onOpenFile,
}: {
  onNew: (kind: PaneKind) => void;
  onOpenFile: () => void;
}) {
  const menu = useMenu();
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByHold = useRef(false);

  const cancelHold = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  useEffect(() => cancelHold, []);

  return (
    <div ref={menu.wrapRef} className="relative flex shrink-0 items-stretch">
      <button
        type="button"
        title="New tab — hold for other kinds"
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onPointerDown={() => {
          openedByHold.current = false;
          cancelHold();
          holdTimer.current = setTimeout(() => {
            openedByHold.current = true;
            menu.reveal();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelHold();
          openedByHold.current = true;
          menu.reveal();
        }}
        onClick={() => {
          // A press that became a hold already did something; the click that
          // follows it must not also open a tab.
          if (openedByHold.current) {
            openedByHold.current = false;
            return;
          }
          onNew("terminal");
        }}
        className="flex items-center px-2 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {menu.anchor ? (
        <Menu anchor={menu.anchor} menuRef={menu.menuRef}>
          {NEW_PANE_MENU.map((choice) => (
            <MenuItem
              key={choice.action === "open" ? "open" : choice.kind}
              icon={choice.icon}
              label={choice.label}
              onSelect={() => {
                menu.close();
                if (choice.action === "open") onOpenFile();
                else onNew(choice.kind);
              }}
            />
          ))}
        </Menu>
      ) : null}
    </div>
  );
}

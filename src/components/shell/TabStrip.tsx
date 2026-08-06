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
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";

import { MACOS_TRAFFIC_LIGHT_INSET_PX, usesNativeWindowChrome } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { NEW_PANE_MENU, paneKind } from "@/panes/registry";
import { type PaneKind, type Tab, focusedPane, tabLabel } from "@/state/workspace";
import { WindowControls } from "./WindowControls";

/** Movement before a press on a tab counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** How long the new-tab button must be held before it offers the other kinds. */
const LONG_PRESS_MS = 400;

interface TabStripProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: (kind: PaneKind) => void;
  /** Show the file chooser and open whatever comes back. */
  onOpenFile: () => void;
  onReorder: (tabId: string, toIndex: number) => void;
}

export function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onOpenFile,
  onReorder,
}: TabStripProps) {
  // macOS keeps its native traffic lights, which float over the top-left of the
  // webview. Without this the first tab sits underneath them.
  const [leadingInset, setLeadingInset] = useState(0);
  useEffect(() => {
    setLeadingInset(usesNativeWindowChrome() ? MACOS_TRAFFIC_LIGHT_INSET_PX : 0);
  }, []);

  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const [dragging, setDragging] = useState<string | null>(null);

  const beginTabDrag = (tabId: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const origin = event.clientX;
    const node = event.currentTarget as HTMLElement;
    let armed = false;

    const move = (moveEvent: PointerEvent) => {
      if (!armed) {
        if (Math.abs(moveEvent.clientX - origin) < DRAG_THRESHOLD_PX) return;
        armed = true;
        node.setPointerCapture(moveEvent.pointerId);
        setDragging(tabId);
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
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", finish);
      node.removeEventListener("pointercancel", finish);
      if (armed) node.releasePointerCapture(upEvent.pointerId);
      setDragging(null);
    };

    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", finish);
    node.addEventListener("pointercancel", finish);
  };

  return (
    // `select-none` and the default cursor because this row is chrome: dragging
    // the window must not paint a text selection across the tabs.
    <div
      data-tauri-drag-region
      className="relative z-40 flex h-head shrink-0 cursor-default select-none items-stretch border-b border-border bg-surface-1"
    >
      {/* Reserved for the macOS traffic lights; zero everywhere else. Draggable,
          so the area around the system buttons still moves the window. */}
      {leadingInset > 0 ? (
        <div data-tauri-drag-region className="shrink-0" style={{ width: leadingInset }} />
      ) : null}

      {/* Takes all the room left over by the window controls, so the tabs have
          something to spread into. The drag spacer below shares this box rather
          than sitting outside it, which is what lets tabs grow first and the
          window's drag handle take only what is genuinely spare. */}
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const pane = focusedPane(tab);
          const Icon = pane ? paneKind(pane.kind).icon : null;
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
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => onSelect(tab.id)}
                aria-current={isActive}
                title={tabLabel(tab)}
              >
                {Icon ? (
                  <Icon
                    className={cn("h-3 w-3 shrink-0", isActive ? "text-ink-2" : "text-ink-4")}
                  />
                ) : null}
                <span
                  className={cn("truncate text-[11px]", isActive ? "text-ink-1" : "text-ink-3")}
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

      <WindowControls />
    </div>
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
  const [open, setOpen] = useState(false);
  // Where to draw the menu, in viewport coordinates. It cannot be positioned
  // relative to this button: the tab list scrolls horizontally, and a scroll
  // container clips on *both* axes, so a menu absolutely positioned inside it
  // is cut off at the bottom of the strip and never seen.
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByHold = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const reveal = () => {
    const bounds = wrapRef.current?.getBoundingClientRect();
    if (bounds) setAnchor({ left: bounds.left, top: bounds.bottom });
    setOpen(true);
  };

  const cancelHold = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  useEffect(() => cancelHold, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex shrink-0 items-stretch">
      <button
        type="button"
        title="New tab — hold for other kinds"
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={() => {
          openedByHold.current = false;
          cancelHold();
          holdTimer.current = setTimeout(() => {
            openedByHold.current = true;
            reveal();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelHold();
          openedByHold.current = true;
          reveal();
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

      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ left: anchor.left, top: anchor.top }}
              className="fixed z-50 min-w-[168px] border border-hairline-strong bg-surface-2 py-1 shadow-lg"
            >
              {NEW_PANE_MENU.map((choice) => (
                <button
                  key={choice.action === "open" ? "open" : choice.kind}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    if (choice.action === "open") onOpenFile();
                    else onNew(choice.kind);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink-1"
                >
                  <choice.icon className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                  {choice.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

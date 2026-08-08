/**
 * The one dropdown menu the app has, and the bookkeeping around opening it.
 *
 * Drawn in a portal, always. Both of the places that want a menu — the new-tab
 * button and a pane's kind icon — live inside the tab strip or a pane header,
 * and both of those are `overflow` containers. An absolutely positioned menu
 * inside either is clipped at the bottom of its host and never seen, so the
 * menu is placed in `document.body` at viewport coordinates measured from the
 * control that opened it.
 *
 * `useMenu` holds the two refs that outside-click detection needs — the control
 * and the menu itself — because a click inside the menu must not be read as a
 * click away from it, and the menu is not a descendant of the control.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Where the menu is drawn, in viewport coordinates. */
export interface MenuAnchor {
  left: number;
  top: number;
}

/**
 * Kept in step with the `min-w` below. Used only to keep a menu opened near the
 * right edge of the window from hanging off it — a real measurement would need
 * the menu to exist first, which is a frame too late to be useful.
 */
const MENU_WIDTH_PX = 196;

export function useMenu() {
  // `null` is closed. One piece of state rather than an `open` flag beside a
  // position, which can disagree.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = anchor !== null;

  const close = useCallback(() => setAnchor(null), []);

  const reveal = useCallback(() => {
    const bounds = wrapRef.current?.getBoundingClientRect();
    setAnchor({
      left: Math.max(0, Math.min(bounds?.left ?? 0, window.innerWidth - MENU_WIDTH_PX)),
      top: bounds?.bottom ?? 0,
    });
  }, []);

  const toggle = useCallback(() => {
    if (anchor === null) reveal();
    else close();
  }, [anchor, reveal, close]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    // Capture, because the app's own key handler runs there and would otherwise
    // never let Escape through.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  return { anchor, open, reveal, close, toggle, wrapRef, menuRef };
}

export function Menu({
  anchor,
  menuRef,
  children,
}: {
  anchor: MenuAnchor;
  menuRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: anchor.left, top: anchor.top, minWidth: MENU_WIDTH_PX }}
      // Capped and scrollable: the tab list this can enumerate has no upper
      // bound, and a menu taller than the window is a menu with items you
      // cannot reach.
      className="fixed z-50 max-h-[70vh] overflow-y-auto border border-hairline-strong bg-surface-2 py-1 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon: Icon,
  label,
  onSelect,
}: {
  icon: LucideIcon | null;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      title={label}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[length:var(--fs-11)] text-ink-2 hover:bg-surface-3 hover:text-ink-1"
    >
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** A heading over a run of items. `divided` rules off the group above it. */
export function MenuHeading({ children, divided = false }: { children: ReactNode; divided?: boolean }) {
  return (
    <div
      className={cn(
        "px-3 pb-1 pt-1 text-[length:var(--fs-10)] uppercase tracking-wide text-ink-4",
        divided && "mt-1 border-t border-border pt-2",
      )}
    >
      {children}
    </div>
  );
}

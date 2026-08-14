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
 * `useMenu` holds the refs that outside-click detection needs — the control,
 * the menu, and any submenu panels — because a click inside any of them must
 * not be read as a click away from the menu, and none of them is a descendant
 * of the control. A submenu is another portal for the same reason the menu is,
 * so it registers itself rather than being found by walking the DOM.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";

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
/** The same, for the panel a submenu flies out into. */
const SUBMENU_WIDTH_PX = 232;

export type MenuState = ReturnType<typeof useMenu>;

export function useMenu() {
  // `null` is closed. One piece of state rather than an `open` flag beside a
  // position, which can disagree.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Submenu panels, which are portals of their own and so not inside `menuRef`. */
  const surfaces = useRef(new Set<HTMLElement>());
  const open = anchor !== null;

  const close = useCallback(() => setAnchor(null), []);

  /** Open at an explicit point — what a right-click somewhere means. */
  const revealAt = useCallback((left: number, top: number) => {
    setAnchor({
      left: Math.max(0, Math.min(left, window.innerWidth - MENU_WIDTH_PX)),
      top: Math.max(0, top),
    });
  }, []);

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
    const inside = (target: globalThis.Node) => {
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return true;
      for (const surface of surfaces.current) if (surface.contains(target)) return true;
      return false;
    };
    const onDown = (event: MouseEvent) => {
      if (inside(event.target as globalThis.Node)) return;
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

  return { anchor, open, reveal, revealAt, close, toggle, wrapRef, menuRef, surfaces };
}

/**
 * What a submenu needs from the menu it is inside: somewhere to register its
 * panel so a click in it is not a click away, and a way to know whether some
 * *other* submenu has since been opened and it should close.
 */
interface MenuScope {
  addSurface: (element: HTMLElement | null) => void;
  /** The id of the submenu currently open, or null. Hovering sets it. */
  openSub: string | null;
  setOpenSub: (id: string | null) => void;
}

const MenuScopeContext = createContext<MenuScope | null>(null);

export function Menu({
  menu,
  children,
}: {
  menu: MenuState;
  children: ReactNode;
}) {
  const [openSub, setOpenSub] = useState<string | null>(null);
  const { surfaces } = menu;

  const scope = useMemo<MenuScope>(
    () => ({
      addSurface: (element) => {
        if (element) surfaces.current.add(element);
      },
      openSub,
      setOpenSub,
    }),
    [surfaces, openSub],
  );

  // A menu that has closed has no submenus, and a stale set of panels would
  // keep the *next* opening from ever closing on an outside click.
  useEffect(() => {
    if (menu.anchor === null) {
      surfaces.current.clear();
      setOpenSub(null);
    }
  }, [menu.anchor, surfaces]);

  if (menu.anchor === null) return null;

  return createPortal(
    <MenuScopeContext.Provider value={scope}>
      <div
        ref={menu.menuRef}
        role="menu"
        style={{ left: menu.anchor.left, top: menu.anchor.top, minWidth: MENU_WIDTH_PX }}
        // Capped and scrollable: the tab list this can enumerate has no upper
        // bound, and a menu taller than the window is a menu with items you
        // cannot reach.
        className="fixed z-50 max-h-[70vh] overflow-y-auto border border-hairline-strong bg-surface-2 py-1 shadow-lg"
      >
        {children}
      </div>
    </MenuScopeContext.Provider>,
    document.body,
  );
}

export function MenuItem({
  icon: Icon,
  label,
  onSelect,
  /** Drawn instead of an icon, for a row that shows rather than names a thing. */
  adornment,
  selected = false,
  onHover,
}: {
  icon?: LucideIcon | null;
  label: string;
  onSelect: () => void;
  adornment?: ReactNode;
  selected?: boolean;
  /** Pointing at the row means something on its own — see the theme picker. */
  onHover?: () => void;
}) {
  const scope = useContext(MenuScopeContext);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      // Moving onto a plain row closes whatever submenu was open, which is what
      // makes a menu feel like one surface rather than two competing ones.
      onMouseEnter={() => {
        scope?.setOpenSub(null);
        onHover?.();
      }}
      title={label}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[length:var(--fs-11)] hover:bg-surface-3 hover:text-ink-1",
        selected ? "text-ink-1" : "text-ink-2",
      )}
    >
      {adornment ?? (Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" /> : null)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <span className="shrink-0 text-brand">•</span> : null}
    </button>
  );
}

/**
 * A row that opens a panel beside it.
 *
 * Opens on hover *and* on click, because the two are different gestures with
 * the same intent: a mouse arriving on the row has already asked the question,
 * and a click is what someone does when the hover did not seem to take. It
 * stays open until another row is hovered, so crossing the gap on the way to
 * the panel does not close the thing being aimed at.
 */
export function MenuSubmenu({
  icon: Icon,
  label,
  children,
}: {
  icon?: LucideIcon | null;
  label: string;
  children: ReactNode;
}) {
  const scope = useContext(MenuScopeContext);
  const id = useId();
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<MenuAnchor | null>(null);
  const open = scope?.openSub === id;

  /**
   * The scope the panel's own rows see.
   *
   * Context reaches through a portal, so without this every row *inside* the
   * panel would inherit the outer menu's `setOpenSub` — and since a plain row
   * closes the open submenu on hover, pointing at one would shut the panel it
   * is in. Registration still goes to the outer menu, which is the one doing
   * the outside-click detection.
   */
  const inner = useMemo<MenuScope>(
    () => ({
      addSurface: (element) => scope?.addSurface(element),
      openSub: null,
      setOpenSub: () => {},
    }),
    [scope],
  );

  const place = useCallback(() => {
    const bounds = rowRef.current?.getBoundingClientRect();
    if (!bounds) return;
    // Flip to the left when there is no room on the right, which there very
    // often is not: this menu is opened from a tab, and tabs run to the edge.
    const right = bounds.right + SUBMENU_WIDTH_PX <= window.innerWidth;
    setAt({
      left: right ? bounds.right : Math.max(0, bounds.left - SUBMENU_WIDTH_PX),
      // Nudged up by the panel's own padding so the first entry lines up with
      // the row that opened it, and clamped so a long panel stays on screen.
      top: Math.max(0, Math.min(bounds.top - 5, window.innerHeight * 0.24)),
    });
  }, []);

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={() => {
          place();
          scope?.setOpenSub(id);
        }}
        onClick={() => {
          place();
          scope?.setOpenSub(open ? null : id);
        }}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[length:var(--fs-11)] hover:bg-surface-3 hover:text-ink-1",
          open ? "bg-surface-3 text-ink-1" : "text-ink-2",
        )}
      >
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" /> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className="h-3 w-3 shrink-0 text-ink-4" />
      </button>

      {open && at
        ? createPortal(
            <div
              ref={(node) => scope?.addSurface(node)}
              role="menu"
              style={{ left: at.left, top: at.top, width: SUBMENU_WIDTH_PX }}
              className="fixed z-50 max-h-[68vh] overflow-y-auto border border-hairline-strong bg-surface-2 py-1 shadow-lg"
            >
              <MenuScopeContext.Provider value={inner}>{children}</MenuScopeContext.Provider>
            </div>,
            document.body,
          )
        : null}
    </>
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

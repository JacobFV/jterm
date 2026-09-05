/**
 * Every pane in the window, in one flat list.
 *
 * The single most important thing here is what is *not* happening: panes are
 * not rendered inside the split tree, and they are not rendered inside their
 * tab either. They are rendered from one flat list covering every tab at once,
 * always in the same order, absolutely positioned from rectangles the tree is
 * asked to compute. Rendering the tree directly would be the obvious approach
 * and would be a serious bug — moving a pane would move its component in the
 * React tree, React would unmount and remount it, and a live shell would be
 * destroyed every time someone dragged a pane. This way a rearrangement is a
 * change of `style`, and the process behind the pane never notices.
 *
 * Flattening *across* tabs is what earns the second half of that. A tab dropped
 * into the workspace hands its panes to another tab, and if each tab owned a
 * container those panes would change parents — which React implements by
 * tearing the old one down and building a new one. The shell would survive
 * (nothing here kills it) but the terminal in front of it would not: the
 * scrollback on screen would be gone, and `pty_spawn` would refuse the second
 * spawn into a live id, leaving a pane wired to nothing. With one list, moving
 * a pane between tabs changes which rectangle it is given. That is all.
 *
 * Two smaller decisions follow from the same reasoning:
 *
 *   - Panes in inactive tabs keep their rectangles and are hidden with
 *     `visibility`, not `display: none`. A `display: none` pane measures 0×0,
 *     which would tell every backgrounded shell that its window is one column
 *     wide and make it re-wrap everything it has printed.
 *   - Zooming does not change any rectangle. The zoomed pane is drawn over its
 *     siblings instead, so their shells keep the size they had and come back
 *     unchanged.
 *
 * Pop-ups are in the same list, for exactly the reason the tabs are. A pane
 * moved from a tab onto the rail must not change parents in the React tree, so
 * "floating" is a different *rectangle and header*, not a different container —
 * and the branch below is written to keep the pane component in the same slot
 * of the same JSX whichever it is. A minimised pop-up is slid down past the
 * bottom edge rather than shrunk: the pane keeps its size, so the shell in it
 * is never told the window became 22 pixels tall.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Maximize2, Minimize2, Minus, X } from "lucide-react";

import { resolveTheme, themeStyle } from "@/lib/appearance";
import { useSettings, useSystemScheme } from "@/lib/useSettings";
import { cn } from "@/lib/utils";
import { paneKind } from "@/panes/registry";
import { type Action, type Popup, type Tab, paneLabel, themeOf } from "@/state/workspace";
import { type DropEdge, type Layout, type Rect, countPanes, layout } from "@/state/tree";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { ErrorBoundary } from "./ErrorBoundary";
import { PaneMenu, type PaneMenuActions } from "./PaneMenu";

/** Height of the strip above each pane. Only drawn when a tab has splits. */
const HEADER_PX = 22;
/** Grab width of a divider, centred on the one-pixel line it draws. */
const DIVIDER_PX = 9;
/**
 * How much of a pane's width or height counts as its edge for dropping.
 *
 * A pane dropped in the middle swaps with the pane under it instead of
 * re-splitting, so this is also the size of the "swap" target: large enough to
 * hit deliberately, small enough that aiming at an edge is not accidentally a
 * swap. A *tab* dropped in the middle has nothing to swap with, so for that
 * gesture the whole pane is edges.
 */
const EDGE_ZONE = 0.28;
/** How far a pop-up sits off the bottom edge, so it reads as floating. */
const RAIL_PX = 10;
/** Where the pop-ups start, above the zoom layer and below the drop preview. */
const POPUP_Z = 25;

interface PaneDrag {
  paneId: string;
  target: { paneId: string; edge: DropEdge } | null;
}

/** A tab being dragged out of the strip and over the workspace. */
export interface TabDrag {
  tabId: string;
  x: number;
  y: number;
}

/** Where a dragged tab would be grafted in. */
export interface TabDropTarget {
  tabId: string;
  paneId: string;
  edge: Exclude<DropEdge, "center">;
}

interface WorkspaceProps {
  tabs: Tab[];
  activeTabId: string | null;
  /** The panes floating over every tab, back to front. */
  popups: Popup[];
  /** Which pop-up has the keyboard, or `null` when a tab's pane has it. */
  focusedPopupId: string | null;
  dispatch: (action: Action) => void;
  /** Closing may need to ask about unsaved work, which is the app's business
   *  rather than the layout's. Told only the pane: it may be in a tab or on
   *  the rail, and the app is the one that knows which. */
  onClosePane: (paneId: string) => void;
  /** What a pane's kind icon offers. Replacing a pane closes the old one, which
   *  is the app's business for the same reason closing is. */
  paneMenu: PaneMenuActions;
  tabDrag: TabDrag | null;
  /** Reported upwards because the release happens in the tab strip, which
   *  cannot work out where in here the pointer was. */
  onTabDropTarget: (target: TabDropTarget | null) => void;
}

/** A pane in a tab's split tree, or one floating on the rail. */
type Placement =
  | { kind: "grid"; tab: Tab; rect: Rect }
  | { kind: "popup"; popup: Popup; index: number };

export function Workspace({
  tabs,
  activeTabId,
  popups,
  focusedPopupId,
  dispatch,
  onClosePane,
  paneMenu,
  tabDrag,
  onTabDropTarget,
}: WorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const settings = useSettings();
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const [dividerNode, setDividerNode] = useState<string | null>(null);
  const [tabDrop, setTabDrop] = useState<TabDropTarget | null>(null);

  const layouts = useMemo(
    () => new Map<string, Layout>(tabs.map((tab) => [tab.id, layout(tab.root)])),
    [tabs],
  );

  /** Where each pane sits — in a tab's tree, or on the rail. Every pane there is. */
  const placements = useMemo(() => {
    const out = new Map<string, Placement>();
    for (const tab of tabs) {
      for (const box of layouts.get(tab.id)?.panes ?? []) {
        out.set(box.paneId, { kind: "grid", tab, rect: box.rect });
      }
    }
    popups.forEach((popup, index) => {
      out.set(popup.pane.id, { kind: "popup", popup, index });
    });
    return out;
  }, [tabs, layouts, popups]);

  const order = useStableOrder(placements);

  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const activePanes = useMemo(
    () => (active === null ? [] : (layouts.get(active.id)?.panes ?? [])),
    [active, layouts],
  );

  const rectOf = useCallback(
    (paneId: string) => {
      const placement = placements.get(paneId);
      return placement?.kind === "grid" ? placement.rect : null;
    },
    [placements],
  );

  /**
   * What the *window* is wearing — the active tab's theme, or the app's.
   *
   * Not what a pane wears; every pane below writes its own tokens whatever this
   * is. It is here for one question only: whether the backdrop `App` draws
   * across the whole pane area is already the drawing a given pane wants, or
   * whether that pane has to run one of its own.
   */
  const windowChoice = themeOf(settings.theme, active);

  // Colours are computed during render here, so a desktop that flips under a
  // `system` choice has to reach React and not merely the document.
  useSystemScheme();

  /** Pointer position as a fraction of the grid, for hit-testing. */
  const toFraction = useCallback((clientX: number, clientY: number) => {
    const host = hostRef.current;
    if (host === null) return null;
    const bounds = host.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return null;
    return {
      x: ((clientX - bounds.left) / bounds.width) * 100,
      y: ((clientY - bounds.top) / bounds.height) * 100,
    };
  }, []);

  /* ── A tab being dragged in from the strip ────────────────────────── */

  // Worked out in an effect rather than during render because it has to measure
  // the DOM, and a render is not a moment at which the DOM can be trusted to
  // have caught up. Tab drags are a human-speed gesture; the extra pass is free.
  useEffect(() => {
    let next: TabDropTarget | null = null;

    // Dropping a tab into its own workspace is asking for the tab to contain
    // itself, so it is simply not a target.
    if (tabDrag !== null && active !== null && tabDrag.tabId !== active.id) {
      const point = toFraction(tabDrag.x, tabDrag.y);
      const hit = point === null ? null : dropTarget(activePanes, point, null, false);
      if (hit !== null && hit.edge !== "center") {
        next = { tabId: active.id, paneId: hit.paneId, edge: hit.edge };
      }
    }

    setTabDrop(next);
    onTabDropTarget(next);
  }, [tabDrag, active, activePanes, toFraction, onTabDropTarget]);

  /* ── Dragging a pane onto another ─────────────────────────────────── */

  const beginPaneDrag = (tabId: string, paneId: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    setPaneDrag({ paneId, target: null });

    // A pane only ever moves within its own tab, so the panes it can be dropped
    // on are that tab's — not whatever happens to be on screen.
    const within = layouts.get(tabId)?.panes ?? [];

    const move = (moveEvent: PointerEvent) => {
      const point = toFraction(moveEvent.clientX, moveEvent.clientY);
      if (point === null) return;
      setPaneDrag((current) =>
        current === null ? current : { ...current, target: dropTarget(within, point, current.paneId, true) },
      );
    };

    const finish = () => {
      grip.releasePointerCapture(event.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", finish);
      grip.removeEventListener("pointercancel", finish);
      setPaneDrag((current) => {
        if (current?.target) {
          dispatch({
            type: "pane/move",
            tabId,
            paneId: current.paneId,
            targetPaneId: current.target.paneId,
            edge: current.target.edge,
          });
        }
        return null;
      });
    };

    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", finish);
    grip.addEventListener("pointercancel", finish);
  };

  /* ── Dragging a divider ───────────────────────────────────────────── */

  const beginDividerDrag =
    (tabId: string, nodeId: string, axis: "x" | "y", area: Rect) =>
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      setDividerNode(nodeId);

      const move = (moveEvent: PointerEvent) => {
        const point = toFraction(moveEvent.clientX, moveEvent.clientY);
        if (point === null) return;
        const ratio =
          axis === "x"
            ? (point.x - area.left) / area.width
            : (point.y - area.top) / area.height;
        dispatch({ type: "pane/ratio", tabId, nodeId, ratio });
      };

      const finish = () => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        setDividerNode(null);
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    };

  /* ── Sliding a pop-up along the rail ──────────────────────────────── */

  /**
   * A pop-up moves in one axis only.
   *
   * It is a rail rather than free floating on purpose: pop-ups are for things
   * kept to hand while you work behind them, and anything that can be dragged
   * anywhere ends up over the thing it was covering for. Left and right is
   * enough to get one out of the way of another.
   */
  const beginRailDrag = (paneId: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const host = hostRef.current;
    const popup = popups.find((candidate) => candidate.pane.id === paneId);
    if (host === null || popup === undefined) return;

    dispatch({ type: "popup/focus", paneId });
    const bounds = host.getBoundingClientRect();
    if (bounds.width < 1) return;
    // Where in the header it was grabbed, so the pop-up does not jump its own
    // left edge to the pointer on the first move.
    const grip = event.clientX - (bounds.left + popup.x * bounds.width);
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      dispatch({
        type: "popup/move",
        paneId,
        x: (moveEvent.clientX - grip - bounds.left) / bounds.width,
      });
    };

    const finish = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  /* ── Where a drop would land ──────────────────────────────────────── */

  const dropRect = paneDrag?.target
    ? previewRect(rectOf(paneDrag.target.paneId), paneDrag.target.edge)
    : tabDrop !== null
      ? previewRect(rectOf(tabDrop.paneId), tabDrop.edge)
      : null;

  const dividers = active === null ? [] : (layouts.get(active.id)?.dividers ?? []);

  return (
    <div ref={hostRef} className="pane-ground relative h-full w-full overflow-hidden">
      {order.map((paneId) => {
        const placement = placements.get(paneId);
        if (placement === undefined) return null;

        // A pop-up belongs to the window rather than to a tab, so half of what
        // follows has no tab to ask. Held apart here, once, rather than by
        // asking `placement.kind` in twenty places below.
        const popup = placement.kind === "popup" ? placement.popup : null;
        const tab = placement.kind === "grid" ? placement.tab : null;
        const pane = popup?.pane ?? (tab ? tab.panes[paneId] : undefined);
        if (!pane) return null;

        const definition = paneKind(pane.kind);
        // A pop-up is on screen whatever tab is: that is what it is for.
        const onScreen = popup !== null || tab!.id === activeTabId;
        const isZoomed = tab !== null && tab.zoomedPaneId === paneId;
        // The visual mark of focus, which a tab keeps even while a pop-up in
        // front of it has the keyboard — the tab has not stopped being where
        // you were.
        const focused = popup !== null ? focusedPopupId === paneId : tab!.focusedPaneId === paneId;
        // Who the keyboard actually belongs to. One pane in the window at most.
        const hasKeyboard =
          popup !== null ? focusedPopupId === paneId : onScreen && focused && focusedPopupId === null;
        const split = tab !== null && countPanes(tab.root) > 1;
        // A pop-up always has a header — it is the thing you drag it by, and the
        // only place its minimise and full-screen controls can live.
        const header = popup !== null || split;

        // "On screen for the user": its tab is up and it is not hidden behind a
        // zoomed sibling. A media pane mutes itself on this; nothing should be
        // playing out of a tab you cannot see — nor out of a minimised pop-up.
        const showing =
          popup !== null
            ? popup.state !== "minimized"
            : onScreen && (tab!.zoomedPaneId === null || isZoomed);

        // The innermost theme actually chosen for this pane: its own, else its
        // tab's, else the app's. A pop-up has no tab in the middle.
        const choice = themeOf(settings.theme, tab, pane);
        // A drawing of its own, only where the window's is not already the one
        // this pane wants — and only where it can be seen, for the same reason
        // the media pane stands down.
        const ownBackdrop = showing && choice !== windowChoice;

        const box =
          placement.kind === "popup"
            ? popupBox(placement.popup, placement.index)
            : {
                left: `${(isZoomed ? 0 : placement.rect.left)}%`,
                top: `${(isZoomed ? 0 : placement.rect.top)}%`,
                width: `${(isZoomed ? 100 : placement.rect.width)}%`,
                height: `${(isZoomed ? 100 : placement.rect.height)}%`,
                // Hidden, not unmounted, and not `display: none` — see the note
                // at the top of this file.
                visibility: (onScreen ? "visible" : "hidden") as "visible" | "hidden",
                pointerEvents: (onScreen ? "auto" : "none") as "auto" | "none",
                zIndex: onScreen ? (isZoomed ? 20 : 1) : 0,
              };

        return (
          <div
            key={paneId}
            className={cn(
              "absolute overflow-hidden",
              // A pane being dragged is dimmed rather than lifted: it stays
              // where it is, and the highlight shows where it would land.
              paneDrag?.paneId === paneId && "opacity-40",
              // A pop-up is lifted off the page: a border and a shadow, because
              // it overlaps panes that are drawn in the same colours it is.
              popup !== null &&
                cn(
                  "border shadow-[0_8px_24px_rgba(0,0,0,0.45)]",
                  focused ? "border-hairline-strong" : "border-border",
                ),
            )}
            style={{
              ...box,
              // Every colour token, addressed at this box. Custom properties
              // inherit, so this is the whole of how one pane wears a theme its
              // neighbour does not: the header, the terminal and a notepad's
              // syntax colours below all resolve to the nearest declaration,
              // and nothing had to be told which theme it is in.
              ...themeStyle(choice, settings.ambientPresence),
            }}
          >
            {/* A backdrop of this pane's own, for a living theme the window is
                not already drawing — without it a pane set to Lorenz would be
                Lorenz's colours over somebody else's weather. Only for the tab
                on screen: the drawing is an animation, and one running behind a
                pane nobody can see is a loop burning frames for nothing. */}
            {ownBackdrop ? <AmbientBackdrop theme={resolveTheme(choice)} /> : null}

            <div
              className={cn(
                // `relative` so it paints over the backdrop above rather than
                // under it — an absolutely positioned sibling would otherwise
                // come last in the painting order whatever the source order.
                "relative flex h-full w-full flex-col",
                // The focused pane is marked by its border, the quietest signal
                // that still works when every pane is showing black text. A
                // pop-up's is on the outer box, which is the thing that floats.
                split && "border",
                split && focused ? "border-hairline-strong" : "border-border",
              )}
            >
              {header ? (
                <div
                  className="flex shrink-0 cursor-grab touch-none select-none items-center gap-1 border-b border-border bg-surface-1 pl-1 pr-1 active:cursor-grabbing"
                  style={{ height: HEADER_PX }}
                  title={
                    popup !== null
                      ? "Drag along the rail · double-click for full screen"
                      : "Drag to rearrange · double-click to zoom"
                  }
                  onPointerDown={(event) => {
                    if (popup !== null) {
                      beginRailDrag(paneId)(event);
                      return;
                    }
                    dispatch({ type: "pane/focus", tabId: tab!.id, paneId });
                    beginPaneDrag(tab!.id, paneId)(event);
                  }}
                  onDoubleClick={() =>
                    popup !== null
                      ? dispatch({
                          type: "popup/state",
                          paneId,
                          state: popup.state === "full" ? "open" : "full",
                        })
                      : dispatch({ type: "pane/zoom", tabId: tab!.id, paneId })
                  }
                >
                  {/* Only for the tab on screen. The menu is drawn in a portal
                      to escape this container's clipping, which also means the
                      `visibility: hidden` above does not reach it — a menu left
                      open on a tab you have switched away from would hang over
                      the one you switched to. Unmounting takes it with the tab.
                      Hidden panes keep the icon so the header does not shift.
                      Stopped here so a click on the icon opens the menu instead
                      of starting a drag of the header underneath it. */}
                  {onScreen ? (
                    <span onPointerDown={(event) => event.stopPropagation()}>
                      <PaneMenu
                        tabs={tabs}
                        tab={tab}
                        activeTabId={activeTabId}
                        pane={pane}
                        // A header exists where the tab is split, or where the
                        // pane is floating — in both cases this icon has
                        // something to be told apart from, which is exactly
                        // when theming one pane alone means anything.
                        scope="pane"
                        actions={paneMenu}
                        muted={!focused}
                      />
                    </span>
                  ) : (
                    <definition.icon className="h-3 w-3 shrink-0 text-ink-4" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)]",
                      focused ? "text-ink-2" : "text-ink-4",
                    )}
                    title={paneLabel(pane)}
                  >
                    {paneLabel(pane)}
                  </span>
                  {isZoomed ? (
                    <button
                      type="button"
                      title="Unzoom"
                      aria-label="Unzoom"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        dispatch({ type: "pane/zoom", tabId: tab!.id, paneId });
                      }}
                      className="shrink-0 rounded-sm p-0.5 text-brand hover:bg-surface-2"
                    >
                      <Minimize2 className="h-3 w-3" />
                    </button>
                  ) : null}

                  {/* A pop-up's two states, as two buttons rather than one that
                      cycles: "put this down" and "let this fill the window" are
                      different requests, and either can follow either. */}
                  {popup !== null ? (
                    <>
                      <HeaderButton
                        title={popup.state === "minimized" ? "Restore" : "Minimise"}
                        onClick={() =>
                          dispatch({
                            type: "popup/state",
                            paneId,
                            state: popup.state === "minimized" ? "open" : "minimized",
                          })
                        }
                      >
                        {popup.state === "minimized" ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <Minus className="h-3 w-3" />
                        )}
                      </HeaderButton>
                      <HeaderButton
                        title={popup.state === "full" ? "Back to the rail" : "Full screen"}
                        onClick={() =>
                          dispatch({
                            type: "popup/state",
                            paneId,
                            state: popup.state === "full" ? "open" : "full",
                          })
                        }
                      >
                        {popup.state === "full" ? (
                          <Minimize2 className="h-3 w-3" />
                        ) : (
                          <Maximize2 className="h-3 w-3" />
                        )}
                      </HeaderButton>
                    </>
                  ) : null}

                  <button
                    type="button"
                    title="Close pane"
                    aria-label={`Close ${paneLabel(pane)}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClosePane(paneId);
                    }}
                    className="shrink-0 rounded-sm p-0.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                {/* Per pane, and keyed on the pane rather than shared: a
                    boundary that has caught stays caught, so one placed around
                    the whole grid would take every sibling down with the one
                    that threw — which is the failure it exists to prevent. */}
                <ErrorBoundary label={paneLabel(pane)}>
                  <definition.Component
                    pane={pane}
                    theme={choice}
                    focused={hasKeyboard}
                    visible={showing}
                    onFocus={() =>
                      dispatch(
                        popup !== null
                          ? { type: "popup/focus", paneId }
                          : { type: "pane/focus", tabId: tab!.id, paneId },
                      )
                    }
                    onMeta={(patch) => dispatch({ type: "pane/meta", paneId, patch })}
                  />
                </ErrorBoundary>
              </div>
            </div>
          </div>
        );
      })}

      {/* Dividers sit over the seam rather than between the panes, so the
          rectangles above still meet exactly. Only the tab on screen has any:
          the others are not there to be dragged. */}
      {active !== null && active.zoomedPaneId === null
        ? dividers.map((divider) => {
            const horizontal = divider.axis === "x";
            const position = horizontal
              ? divider.rect.left + divider.rect.width * divider.ratio
              : divider.rect.top + divider.rect.height * divider.ratio;
            return (
              <div
                key={divider.nodeId}
                onPointerDown={beginDividerDrag(
                  active.id,
                  divider.nodeId,
                  divider.axis,
                  divider.rect,
                )}
                className={cn(
                  "absolute z-10 touch-none",
                  horizontal ? "cursor-col-resize" : "cursor-row-resize",
                )}
                style={
                  horizontal
                    ? {
                        left: `calc(${position}% - ${DIVIDER_PX / 2}px)`,
                        top: `${divider.rect.top}%`,
                        width: DIVIDER_PX,
                        height: `${divider.rect.height}%`,
                      }
                    : {
                        top: `calc(${position}% - ${DIVIDER_PX / 2}px)`,
                        left: `${divider.rect.left}%`,
                        height: DIVIDER_PX,
                        width: `${divider.rect.width}%`,
                      }
                }
                role="separator"
                aria-orientation={horizontal ? "vertical" : "horizontal"}
              >
                <div
                  className={cn(
                    "bg-transparent transition-colors",
                    horizontal ? "mx-auto h-full w-px" : "my-auto h-px w-full",
                    dividerNode === divider.nodeId && "bg-brand",
                  )}
                />
              </div>
            );
          })
        : null}

      {/* Where the dragged pane — or the dragged tab — would land. */}
      {dropRect ? (
        <div
          className="pointer-events-none absolute z-[24] border-2 border-brand bg-brand/10"
          style={{
            left: `${dropRect.left}%`,
            top: `${dropRect.top}%`,
            width: `${dropRect.width}%`,
            height: `${dropRect.height}%`,
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Where a pop-up sits, in CSS.
 *
 * Anchored to the bottom rather than the top, because the rail is the bottom:
 * a pop-up should keep its distance from that edge as the window is resized,
 * not from the one it is nowhere near.
 *
 * Minimising slides the box down instead of shortening it, leaving only the
 * header above the edge for the container's `overflow: hidden` to clip against.
 * The pane inside therefore keeps its size — a terminal told it is 22 pixels
 * tall would re-wrap every line it has printed, and would have to do it again
 * on the way back.
 */
function popupBox(popup: Popup, index: number): React.CSSProperties {
  const z = POPUP_Z + index;
  if (popup.state === "full") {
    return { left: 0, bottom: 0, width: "100%", height: "100%", zIndex: z };
  }

  const height = `${popup.height * 100}%`;
  return {
    left: `${popup.x * 100}%`,
    width: `${popup.width * 100}%`,
    height,
    bottom:
      popup.state === "minimized"
        ? `calc(${RAIL_PX}px + ${HEADER_PX}px - ${height})`
        : RAIL_PX,
    zIndex: z,
  };
}

/** One of the small square controls in a pane or pop-up header. */
function HeaderButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // The header underneath is a drag handle; pressing a button in it is not
      // the start of a drag.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="shrink-0 rounded-sm p-0.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
    >
      {children}
    </button>
  );
}

/**
 * The same pane ids, in an order that never changes.
 *
 * The flat list's *order* is load bearing, not just its membership. React moves
 * DOM nodes to match a reordered keyed list, and an `<iframe>` that is moved in
 * the DOM reloads the page inside it — so a browser pane would navigate back to
 * its home page every time a tab was reordered or a pane was dropped. New panes
 * are therefore appended and never inserted, and the list only ever shrinks
 * where a pane has genuinely gone.
 */
function useStableOrder(placements: Map<string, unknown>): string[] {
  const previous = useRef<string[]>([]);

  const kept = previous.current.filter((paneId) => placements.has(paneId));
  const known = new Set(kept);
  const added: string[] = [];
  for (const paneId of placements.keys()) {
    if (!known.has(paneId)) added.push(paneId);
  }

  const next =
    added.length === 0 && kept.length === previous.current.length ? previous.current : [...kept, ...added];
  previous.current = next;
  return next;
}

/**
 * Which pane is under the pointer, and which of its edges.
 *
 * `allowCenter` is what separates the two gestures this serves. Dragging a pane
 * onto the middle of another swaps them, which is useful when the split you
 * have is the split you want and only the contents are in the wrong order.
 * Dragging a *tab* there has no such meaning — there is no single pane to swap
 * with — so for that the pane is divided into four edges and nothing else.
 */
function dropTarget(
  panes: { paneId: string; rect: Rect }[],
  point: { x: number; y: number },
  dragged: string | null,
  allowCenter: boolean,
): { paneId: string; edge: DropEdge } | null {
  const hit = panes.find(
    ({ rect }) =>
      point.x >= rect.left &&
      point.x <= rect.left + rect.width &&
      point.y >= rect.top &&
      point.y <= rect.top + rect.height,
  );
  if (!hit || hit.paneId === dragged) return null;

  const u = (point.x - hit.rect.left) / hit.rect.width;
  const v = (point.y - hit.rect.top) / hit.rect.height;
  const distances: [DropEdge, number][] = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  const [edge, distance] = distances.reduce((best, entry) =>
    entry[1] < best[1] ? entry : best,
  );
  return { paneId: hit.paneId, edge: allowCenter && distance > EDGE_ZONE ? "center" : edge };
}

/** The highlight shown for a pending drop. */
function previewRect(target: Rect | null, edge: DropEdge): Rect | null {
  if (target === null) return null;
  switch (edge) {
    case "center":
      return target;
    case "left":
      return { ...target, width: target.width / 2 };
    case "right":
      return { ...target, left: target.left + target.width / 2, width: target.width / 2 };
    case "top":
      return { ...target, height: target.height / 2 };
    case "bottom":
      return { ...target, top: target.top + target.height / 2, height: target.height / 2 };
  }
}

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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Minimize2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { paneKind } from "@/panes/registry";
import { type Action, type Tab, paneLabel } from "@/state/workspace";
import { type DropEdge, type Layout, type Rect, countPanes, layout } from "@/state/tree";
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
  dispatch: (action: Action) => void;
  /** Closing may need to ask about unsaved work, which is the app's business
   *  rather than the layout's. */
  onClosePane: (tabId: string, paneId: string) => void;
  /** What a pane's kind icon offers. Replacing a pane closes the old one, which
   *  is the app's business for the same reason closing is. */
  paneMenu: PaneMenuActions;
  tabDrag: TabDrag | null;
  /** Reported upwards because the release happens in the tab strip, which
   *  cannot work out where in here the pointer was. */
  onTabDropTarget: (target: TabDropTarget | null) => void;
}

interface Placement {
  tab: Tab;
  rect: Rect;
}

export function Workspace({
  tabs,
  activeTabId,
  dispatch,
  onClosePane,
  paneMenu,
  tabDrag,
  onTabDropTarget,
}: WorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const [dividerNode, setDividerNode] = useState<string | null>(null);
  const [tabDrop, setTabDrop] = useState<TabDropTarget | null>(null);

  const layouts = useMemo(
    () => new Map<string, Layout>(tabs.map((tab) => [tab.id, layout(tab.root)])),
    [tabs],
  );

  /** Which tab a pane belongs to and where it sits, for every pane there is. */
  const placements = useMemo(() => {
    const out = new Map<string, Placement>();
    for (const tab of tabs) {
      for (const box of layouts.get(tab.id)?.panes ?? []) {
        out.set(box.paneId, { tab, rect: box.rect });
      }
    }
    return out;
  }, [tabs, layouts]);

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
    (paneId: string) => placements.get(paneId)?.rect ?? null,
    [placements],
  );

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

  /* ── Where a drop would land ──────────────────────────────────────── */

  const dropRect = paneDrag?.target
    ? previewRect(rectOf(paneDrag.target.paneId), paneDrag.target.edge)
    : tabDrop !== null
      ? previewRect(rectOf(tabDrop.paneId), tabDrop.edge)
      : null;

  const dividers = active === null ? [] : (layouts.get(active.id)?.dividers ?? []);

  return (
    <div ref={hostRef} className="pane-ground relative h-full w-full overflow-hidden bg-surface-0">
      {order.map((paneId) => {
        const placement = placements.get(paneId);
        if (placement === undefined) return null;
        const { tab, rect } = placement;
        const pane = tab.panes[paneId];
        if (!pane) return null;

        const definition = paneKind(pane.kind);
        const onScreen = tab.id === activeTabId;
        const isZoomed = tab.zoomedPaneId === paneId;
        const focused = tab.focusedPaneId === paneId;
        const split = countPanes(tab.root) > 1;
        const box = isZoomed ? { left: 0, top: 0, width: 100, height: 100 } : rect;

        return (
          <div
            key={paneId}
            className={cn(
              "absolute overflow-hidden",
              // A pane being dragged is dimmed rather than lifted: it stays
              // where it is, and the highlight shows where it would land.
              paneDrag?.paneId === paneId && "opacity-40",
            )}
            style={{
              left: `${box.left}%`,
              top: `${box.top}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
              // Hidden, not unmounted, and not `display: none` — see the note
              // at the top of this file.
              visibility: onScreen ? "visible" : "hidden",
              pointerEvents: onScreen ? "auto" : "none",
              zIndex: onScreen ? (isZoomed ? 20 : 1) : 0,
            }}
          >
            <div
              className={cn(
                "flex h-full w-full flex-col",
                // The focused pane is marked by its border, the quietest signal
                // that still works when every pane is showing black text.
                split && "border",
                split && focused ? "border-hairline-strong" : "border-border",
              )}
            >
              {split ? (
                <div
                  className="flex shrink-0 items-center gap-1 border-b border-border bg-surface-1 pl-0.5 pr-1"
                  style={{ height: HEADER_PX }}
                  onMouseDown={() => dispatch({ type: "pane/focus", tabId: tab.id, paneId })}
                >
                  <button
                    type="button"
                    title="Drag to rearrange"
                    aria-label={`Move ${paneLabel(pane)}`}
                    onPointerDown={beginPaneDrag(tab.id, paneId)}
                    className="shrink-0 cursor-grab touch-none px-0.5 text-ink-4 hover:text-ink-2 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3 w-3" />
                  </button>
                  {/* Only for the tab on screen. The menu is drawn in a portal
                      to escape this container's clipping, which also means the
                      `visibility: hidden` above does not reach it — a menu left
                      open on a tab you have switched away from would hang over
                      the one you switched to. Unmounting takes it with the tab.
                      Hidden panes keep the icon so the header does not shift. */}
                  {onScreen ? (
                    <PaneMenu
                      tabs={tabs}
                      tabId={tab.id}
                      pane={pane}
                      actions={paneMenu}
                      muted={!focused}
                    />
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
                      onClick={() => dispatch({ type: "pane/zoom", tabId: tab.id, paneId })}
                      className="shrink-0 rounded-sm p-0.5 text-brand hover:bg-surface-2"
                    >
                      <Minimize2 className="h-3 w-3" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="Close pane"
                    aria-label={`Close ${paneLabel(pane)}`}
                    onClick={() => onClosePane(tab.id, paneId)}
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
                    focused={onScreen && focused}
                    // "On screen for the user": its tab is up and it is not
                    // hidden behind a zoomed sibling. A media pane mutes itself
                    // on this; nothing should be playing out of a tab you cannot
                    // see.
                    visible={onScreen && (tab.zoomedPaneId === null || isZoomed)}
                    onFocus={() => dispatch({ type: "pane/focus", tabId: tab.id, paneId })}
                    onMeta={(patch) =>
                      dispatch({ type: "pane/meta", tabId: tab.id, paneId, patch })
                    }
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
          className="pointer-events-none absolute z-30 border-2 border-brand bg-brand/10"
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

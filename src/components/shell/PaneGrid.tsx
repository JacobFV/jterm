/**
 * The panes inside one tab.
 *
 * The single most important thing here is what is *not* happening: the panes
 * are not rendered inside the split tree. They are rendered from a flat list,
 * always in the same order, absolutely positioned from rectangles the tree is
 * asked to compute. Rendering the tree directly would be the obvious approach
 * and would be a serious bug — moving a pane would move its component in the
 * React tree, React would unmount and remount it, and a live shell would be
 * destroyed every time someone dragged a pane. This way a rearrangement is a
 * change of `style`, and the process behind the pane never notices.
 *
 * The same reasoning drives two smaller decisions:
 *
 *   - Panes in inactive tabs keep their rectangles and are hidden with
 *     `visibility`, not `display: none`. A `display: none` pane measures 0×0,
 *     which would tell every backgrounded shell that its window is one column
 *     wide and make it re-wrap everything it has printed.
 *   - Zooming does not change any rectangle. The zoomed pane is drawn over its
 *     siblings instead, so their shells keep the size they had and come back
 *     unchanged.
 */

import { useCallback, useRef, useState } from "react";
import { GripVertical, Minimize2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { paneKind } from "@/panes/registry";
import { type Action, type Tab, paneLabel } from "@/state/workspace";
import { type DropEdge, type Rect, countPanes, layout } from "@/state/tree";

/** Height of the strip above each pane. Only drawn when a tab has splits. */
const HEADER_PX = 22;
/** Grab width of a divider, centred on the one-pixel line it draws. */
const DIVIDER_PX = 9;
/**
 * How much of a pane's width or height counts as its edge for dropping.
 *
 * A drop in the middle swaps the two panes instead of re-splitting, so this is
 * also the size of the "swap" target: large enough to hit deliberately, small
 * enough that aiming at an edge is not accidentally a swap.
 */
const EDGE_ZONE = 0.28;

interface DragState {
  paneId: string;
  target: { paneId: string; edge: DropEdge } | null;
}

interface PaneGridProps {
  tab: Tab;
  /** Whether this tab is the one on screen. */
  active: boolean;
  dispatch: (action: Action) => void;
  /** Closing may need to ask about unsaved work, which is the app's business
   *  rather than the layout's. */
  onClosePane: (paneId: string) => void;
}

export function PaneGrid({ tab, active, dispatch, onClosePane }: PaneGridProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dividerNode, setDividerNode] = useState<string | null>(null);

  const { panes, dividers } = layout(tab.root);
  const split = countPanes(tab.root) > 1;
  const zoomed = tab.zoomedPaneId;

  const rectOf = useCallback(
    (paneId: string) => panes.find((pane) => pane.paneId === paneId)?.rect ?? null,
    [panes],
  );

  /** Pointer position as a fraction of the grid, for hit-testing. */
  const toFraction = useCallback((event: PointerEvent | React.PointerEvent) => {
    const host = hostRef.current;
    if (host === null) return null;
    const bounds = host.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return null;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * 100,
      y: ((event.clientY - bounds.top) / bounds.height) * 100,
    };
  }, []);

  /* ── Dragging a pane onto another ─────────────────────────────────── */

  const beginPaneDrag = (paneId: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    setDrag({ paneId, target: null });

    const move = (moveEvent: PointerEvent) => {
      const point = toFraction(moveEvent);
      if (point === null) return;
      setDrag((current) =>
        current === null ? current : { ...current, target: dropTarget(panes, point, current.paneId) },
      );
    };

    const finish = () => {
      grip.releasePointerCapture(event.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", finish);
      grip.removeEventListener("pointercancel", finish);
      setDrag((current) => {
        if (current?.target) {
          dispatch({
            type: "pane/move",
            tabId: tab.id,
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
    (nodeId: string, axis: "x" | "y", area: Rect) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      setDividerNode(nodeId);

      const move = (moveEvent: PointerEvent) => {
        const point = toFraction(moveEvent);
        if (point === null) return;
        const ratio =
          axis === "x"
            ? (point.x - area.left) / area.width
            : (point.y - area.top) / area.height;
        dispatch({ type: "pane/ratio", tabId: tab.id, nodeId, ratio });
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

  const dropRect = drag?.target
    ? previewRect(rectOf(drag.target.paneId), drag.target.edge)
    : null;

  return (
    <div ref={hostRef} className="relative h-full w-full overflow-hidden bg-surface-0">
      {panes.map(({ paneId, rect }) => {
        const pane = tab.panes[paneId];
        if (!pane) return null;
        const definition = paneKind(pane.kind);
        const isZoomed = zoomed === paneId;
        const focused = tab.focusedPaneId === paneId;
        const box = isZoomed ? { left: 0, top: 0, width: 100, height: 100 } : rect;

        return (
          <div
            key={paneId}
            className={cn(
              "absolute overflow-hidden",
              // A pane being dragged is dimmed rather than lifted: it stays
              // where it is, and the highlight shows where it would land.
              drag?.paneId === paneId && "opacity-40",
            )}
            style={{
              left: `${box.left}%`,
              top: `${box.top}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
              zIndex: isZoomed ? 20 : 1,
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
                    onPointerDown={beginPaneDrag(paneId)}
                    className="shrink-0 cursor-grab touch-none px-0.5 text-ink-4 hover:text-ink-2 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3 w-3" />
                  </button>
                  <definition.icon
                    className={cn("h-3 w-3 shrink-0", focused ? "text-ink-2" : "text-ink-4")}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono text-[10px]",
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
                    onClick={() => onClosePane(paneId)}
                    className="shrink-0 rounded-sm p-0.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                <definition.Component
                  pane={pane}
                  focused={active && focused}
                  // "On screen for the user": its tab is up and it is not
                  // hidden behind a zoomed sibling. A media pane mutes itself
                  // on this; nothing should be playing out of a tab you cannot
                  // see.
                  visible={active && (zoomed === null || isZoomed)}
                  onFocus={() => dispatch({ type: "pane/focus", tabId: tab.id, paneId })}
                  onMeta={(patch) =>
                    dispatch({ type: "pane/meta", tabId: tab.id, paneId, patch })
                  }
                />
              </div>
            </div>
          </div>
        );
      })}

      {/* Dividers sit over the seam rather than between the panes, so the
          rectangles above still meet exactly. */}
      {zoomed === null
        ? dividers.map((divider) => {
            const horizontal = divider.axis === "x";
            const position = horizontal
              ? divider.rect.left + divider.rect.width * divider.ratio
              : divider.rect.top + divider.rect.height * divider.ratio;
            return (
              <div
                key={divider.nodeId}
                onPointerDown={beginDividerDrag(divider.nodeId, divider.axis, divider.rect)}
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

      {/* Where the dragged pane would land. */}
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

/** Which pane is under the pointer, and which of its edges. */
function dropTarget(
  panes: { paneId: string; rect: Rect }[],
  point: { x: number; y: number },
  dragged: string,
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
  return { paneId: hit.paneId, edge: distance > EDGE_ZONE ? "center" : edge };
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

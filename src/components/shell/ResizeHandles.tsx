/**
 * Resize grips for an undecorated window.
 *
 * An undecorated window still resizes, but the grab margin comes from the
 * toolkit rather than the compositor and is a few pixels at best — narrow
 * enough that hitting it is a matter of luck. These are explicit, generously
 * sized handles laid over the window edges that call `startResizeDragging`,
 * which is the same operation the frame would have performed.
 *
 * Not rendered on macOS: the OS frame is still there and already does this.
 */
import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { usesNativeWindowChrome } from "@/lib/platform";
import { useIsFullscreen } from "@/lib/useFullscreen";

/** Grab widths. Comfortably past the ~4px a bare frame offers. */
const EDGE_PX = 7;
const CORNER_PX = 16;

/** Structurally identical to the API's `ResizeDirection`, checked at the call. */
type Direction =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

interface Grip {
  direction: Direction;
  cursor: string;
  style: React.CSSProperties;
}

const EDGES: Grip[] = [
  {
    direction: "North",
    cursor: "ns-resize",
    style: { top: 0, left: CORNER_PX, right: CORNER_PX, height: EDGE_PX },
  },
  {
    direction: "South",
    cursor: "ns-resize",
    style: { bottom: 0, left: CORNER_PX, right: CORNER_PX, height: EDGE_PX },
  },
  {
    direction: "West",
    cursor: "ew-resize",
    style: { left: 0, top: CORNER_PX, bottom: CORNER_PX, width: EDGE_PX },
  },
  {
    direction: "East",
    cursor: "ew-resize",
    style: { right: 0, top: CORNER_PX, bottom: CORNER_PX, width: EDGE_PX },
  },
];

const CORNERS: Grip[] = [
  {
    direction: "NorthWest",
    cursor: "nwse-resize",
    style: { top: 0, left: 0, width: CORNER_PX, height: CORNER_PX },
  },
  {
    direction: "NorthEast",
    cursor: "nesw-resize",
    style: { top: 0, right: 0, width: CORNER_PX, height: CORNER_PX },
  },
  {
    direction: "SouthWest",
    cursor: "nesw-resize",
    style: { bottom: 0, left: 0, width: CORNER_PX, height: CORNER_PX },
  },
  {
    direction: "SouthEast",
    cursor: "nwse-resize",
    style: { bottom: 0, right: 0, width: CORNER_PX, height: CORNER_PX },
  },
];

export function ResizeHandles() {
  const [enabled, setEnabled] = useState(false);
  // A fullscreen window does not resize, so these would be seven pixels of
  // nothing laid along each screen edge — and they sit above everything, so the
  // top strip would take clicks meant for the tabs at the one place a pointer
  // can always be thrown: the edge itself.
  const fullscreen = useIsFullscreen();

  useEffect(() => {
    setEnabled(isTauri() && !usesNativeWindowChrome());
  }, []);

  if (!enabled || fullscreen) return null;

  const begin = (direction: Direction) => async (event: React.PointerEvent) => {
    // Left button only; a right-drag on an edge should still reach a context
    // menu rather than silently resizing.
    if (event.button !== 0) return;
    event.preventDefault();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startResizeDragging(direction);
  };

  return (
    // Corners are listed after edges so they win the overlap at each end.
    <>
      {[...EDGES, ...CORNERS].map((grip) => (
        <div
          key={grip.direction}
          onPointerDown={begin(grip.direction)}
          // Above every overlay the app draws: the window must stay
          // resizable whatever is on screen.
          className="fixed z-[60]"
          style={{ ...grip.style, cursor: grip.cursor }}
          aria-hidden
        />
      ))}
    </>
  );
}

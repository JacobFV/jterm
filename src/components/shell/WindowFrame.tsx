/**
 * A hairline where the window ends.
 *
 * On the two platforms that run undecorated, jterm's surfaces go all the way to
 * the pixel the compositor stops at, and against a dark desktop — or another
 * dark terminal behind it — there is nothing to say where one ends and the next
 * begins. Every desktop that takes the frame away from an app expects the app
 * to draw its own edge back; this is that edge, and one hairline is the whole of
 * it, in the same vocabulary as every other separation in the interface.
 *
 * Drawn as an overlay rather than a border on a layout box. A real border would
 * take a pixel off the inside of the window and reflow everything under it —
 * the tab strip, the panes, the terminal's own idea of how many columns fit —
 * every time it appeared or went away. This lies over the top instead, costs no
 * layout at all, and takes no clicks: the resize grips are underneath it and
 * still get every pointer that reaches the edge.
 *
 * Not drawn where the window has no edges to describe:
 *
 *   - **macOS**, which keeps its native frame, already has one — and its own is
 *     rounded, so a square hairline over it would cut the corners off.
 *   - **Fullscreen**, for the reason `lib/useFullscreen.ts` sets out at length:
 *     there is no window there to be the edge of, only a screen.
 *
 * Deliberately still drawn when the window is maximised. It is a pixel against
 * the screen edge, which costs nothing, and the alternative is a second piece
 * of window state to track and get wrong — while on a multi-monitor desktop the
 * line is genuinely useful for saying which screen the window ends on.
 */

import { useEffect, useState } from "react";

import { usesNativeWindowChrome } from "@/lib/platform";
import { isTauri } from "@/lib/tauri";
import { useIsFullscreen } from "@/lib/useFullscreen";

export function WindowFrame() {
  // Settled in an effect rather than at render, the same way `ResizeHandles`
  // does it: both answers come from the user agent, and the first render
  // happens before there is a window to ask about.
  const [owned, setOwned] = useState(false);
  const fullscreen = useIsFullscreen();

  useEffect(() => {
    setOwned(isTauri() && !usesNativeWindowChrome());
  }, []);

  if (!owned || fullscreen) return null;

  return (
    <div
      aria-hidden
      // Above everything, including the menus and the resize grips at `z-[60]`.
      // The edge of the window is in front of what is inside it by definition,
      // and `pointer-events-none` means being on top costs nobody a click.
      className="pointer-events-none fixed inset-0 z-[70] border border-hairline-strong"
    />
  );
}

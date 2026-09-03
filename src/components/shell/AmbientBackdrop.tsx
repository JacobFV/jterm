/**
 * The canvas a living theme draws on, and the one place it is allowed to be.
 *
 * It sits behind the panes and nowhere else. Not behind the tab strip, not
 * behind the file tree: the chrome is where you read filenames and shortcuts,
 * and weather moving under small text is the fastest way to make an interface
 * tiring. Inside the pane area it is a wallpaper the terminal is translucent
 * over, which is what a backdrop should be.
 *
 * Which box "behind the panes" means depends on who rendered it. `App` puts one
 * behind the whole pane area for whatever the window is wearing; `Workspace`
 * puts one inside any pane wearing a living theme the window is not, so a
 * single pane set to Lorenz gets Lorenz rather than borrowing the weather
 * around it.
 *
 * It renders nothing at all for the twenty-odd themes that do not ask for one,
 * so the animation code is not merely idle in that case — there is no canvas,
 * no loop, and nothing to stop.
 */

import { useEffect, useRef } from "react";

import { startAmbient, type AmbientTuning } from "@/lib/ambient";
import { customAmbientById } from "@/lib/customAmbients";
import type { Theme } from "@/lib/themes";
import { useSettings } from "@/lib/useSettings";

/**
 * @param theme Whose drawing this is. The window's — the active tab's theme, or
 *   the app's — for the canvas behind the whole pane area, and a pane's own for
 *   the one `Workspace` puts inside a pane that has been themed differently.
 *   Themes nest, so there can be more than one of these on screen; each is the
 *   backdrop for exactly the box it was rendered into.
 */
export function AmbientBackdrop({ theme }: { theme: Theme }) {
  const settings = useSettings();
  const ambient = theme.ambient ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /**
   * The sliders, behind a ref the loop reads each frame.
   *
   * Deliberately not in the effect's dependencies. Dragging Motion changes
   * these sixty times a second, and restarting the painter on each one would
   * throw away the picture it has built — so the loop asks for the current
   * values instead of being rebuilt around them.
   */
  const tuning = useRef<AmbientTuning>({ motion: 1, activity: 1 });
  tuning.current = { motion: settings.ambientMotion, activity: settings.ambientActivity };

  // Custom ambients (Formula, Mario, and the rest of `customAmbients.ts`) all
  // deliberately reuse the living-theme plumbing while owning their renderers
  // in separate modules. That keeps `ambient.ts`'s painter table unchanged and
  // makes each bespoke scene auditable in its own small file.
  const custom = customAmbientById(theme.id);
  const hidden = (custom === undefined && ambient === null) || settings.ambientPresence === 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || hidden) return;
    if (custom !== undefined) return custom.start(canvas, theme.palette, () => tuning.current);
    if (ambient === null) return;
    return startAmbient(canvas, ambient, theme.palette, () => tuning.current);
  }, [ambient, custom, hidden, theme.id, theme.palette]);

  if (hidden) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // Behind the panes and unclickable. `inset-0` rather than a fixed size:
      // the loop measures itself from the box it is given, so the sidebar
      // opening or the window resizing needs no arithmetic here.
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

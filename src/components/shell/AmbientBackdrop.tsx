/**
 * The canvas a living theme draws on, and the one place it is allowed to be.
 *
 * It sits behind the panes and nowhere else. Not behind the tab strip, not
 * behind the file tree: the chrome is where you read filenames and shortcuts,
 * and weather moving under small text is the fastest way to make an interface
 * tiring. Inside the pane area it is a wallpaper the terminal is translucent
 * over, which is what a backdrop should be.
 *
 * It renders nothing at all for the twenty-odd themes that do not ask for one,
 * so the animation code is not merely idle in that case — there is no canvas,
 * no loop, and nothing to stop.
 */

import { useEffect, useRef } from "react";

import { startAmbient, type AmbientTuning } from "@/lib/ambient";
import { resolveTheme } from "@/lib/appearance";
import { useSettings } from "@/lib/useSettings";

export function AmbientBackdrop() {
  const settings = useSettings();
  const theme = resolveTheme(settings.theme);
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

  // Keyed on the theme's id rather than on the ambient's: two themes can name
  // the same drawing in different colours, and the palette is read once when
  // the loop starts. Restarting is cheap; a running loop holding the previous
  // theme's colours would be wrong for as long as it lived.
  // Nothing to show it through, so nothing to draw and no loop to run. This is
  // the one setting that can switch a living theme's drawing off entirely, and
  // it should cost nothing when it has.
  const hidden = ambient === null || settings.ambientPresence === 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || ambient === null || hidden) return;
    return startAmbient(canvas, ambient, theme.palette, () => tuning.current);
  }, [ambient, hidden, theme.id, theme.palette]);

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

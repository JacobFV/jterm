/**
 * What a theme looks like, small.
 *
 * For most themes that is its background with its hues laid on it. For a living
 * one it is the drawing itself, running — the same painter the real backdrop
 * uses, in the same palette, on a canvas a few pixels across. A still frame of
 * a Julia set turning inside out is a picture of a fractal; the whole reason to
 * choose one is that it moves, so the swatch moves.
 *
 * **Square, not a ribbon.** These were a short wide strip, which is the shape
 * that suits a row of colours and the worst possible shape for a picture: a
 * spiral, a fractal or a lava lamp cropped to a letterbox reads as texture
 * rather than as the thing it is. Squarer costs a little height in the menu and
 * buys the only preview that actually answers the question.
 *
 * The loop stops with the component. `startAmbient` already parks itself while
 * the document is hidden and settles to a still frame under reduced motion, so
 * a menu full of these costs nothing when nobody is looking at it — and only
 * the eight living themes make a canvas at all.
 */

import { useEffect, useRef } from "react";

import { startAmbient } from "@/lib/ambient";
import { swatch, type Theme } from "@/lib/themes";
import { cn } from "@/lib/utils";

/** The live one. Split out so the hook is not conditional on the theme. */
function AmbientSwatch({ theme, className }: { theme: Theme; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ambient = theme.ambient;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || ambient === undefined) return;
    return startAmbient(canvas, ambient, theme.palette);
  }, [ambient, theme.id, theme.palette]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("shrink-0 border border-hairline-strong", className)}
      // The painters measure themselves from the box they are given, so the
      // element is sized by CSS and the canvas follows.
      style={{ background: theme.palette.bg }}
    />
  );
}

/** The still one: the theme's background, with four of its eight hues on it. */
function HueSwatch({
  theme,
  className,
  bars,
}: {
  theme: Theme | null;
  className?: string;
  bars: number;
}) {
  if (theme === null) {
    // `system`, which is not a theme and so has no palette of its own. Drawn as
    // the two foundations meeting, since that is exactly what it means.
    return (
      <span className={cn("flex shrink-0 overflow-hidden border border-hairline-strong", className)}>
        <span className="flex-1 bg-black" />
        <span className="flex-1 bg-white" />
      </span>
    );
  }

  const [bg, ...hues] = swatch(theme);
  // Evenly spaced round the wheel rather than the first few, which would be
  // four neighbours and so four shades of the same thing.
  const step = Math.max(1, Math.floor(hues.length / bars));
  const picked = Array.from({ length: bars }, (_, i) => hues[(i * step) % hues.length]);

  return (
    <span
      className={cn(
        "flex shrink-0 items-end gap-px overflow-hidden border border-hairline-strong p-px",
        className,
      )}
      style={{ background: bg }}
    >
      {picked.map((hue, index) => (
        <span
          key={index}
          className="flex-1"
          // Stepped heights, so the row reads as a little bar chart of the
          // palette rather than as a flat ribbon.
          style={{ background: hue, height: `${40 + (index % 3) * 22}%` }}
        />
      ))}
    </span>
  );
}

export function ThemeSwatch({
  theme,
  className,
  bars = 4,
}: {
  /** `null` is `system`, which has no palette to show. */
  theme: Theme | null;
  className?: string;
  /** How many hues the still version lays down. */
  bars?: number;
}) {
  if (theme !== null && theme.ambient !== undefined) {
    return <AmbientSwatch theme={theme} className={className} />;
  }
  return <HueSwatch theme={theme} className={className} bars={bars} />;
}

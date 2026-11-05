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

import { useEffect, useRef, useSyncExternalStore } from "react";

import { startAmbient } from "@/lib/ambient";
import { finalFrame, frameAt, offsetFor, type Frame } from "@/lib/terminalPreview";
import { swatch, themeById, type Palette, type Theme } from "@/lib/themes";
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

/* ── The terminal preview ─────────────────────────────────────────────── */

/**
 * One clock for every preview on screen. A grid of thirty terminals with a
 * timer each is thirty timers waking the page for the same reason; with one,
 * a tick is one wake and one batch of renders. It runs only while something
 * is subscribed, and skips its work while the document is hidden.
 */
const TICK_MS = 90;
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const tickers = new Set<() => void>();

function subscribeTick(listener: () => void): () => void {
  tickers.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      if (document.hidden) return;
      tick += 1;
      for (const ticker of tickers) ticker();
    }, TICK_MS);
  }
  return () => {
    tickers.delete(listener);
    if (tickers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const still = () => () => {};
const readTick = () => tick;

function prefersStill(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** The screen itself: lines from the bottom up, as a terminal scrolls. */
function Screen({ frame, palette }: { frame: Frame; palette: Palette }) {
  const last = frame.lines.length - 1;
  return (
    <span
      className="absolute inset-0 flex flex-col justify-end overflow-hidden px-1 pb-0.5 font-mono text-[8px] leading-[1.4]"
      style={{ background: palette.bg, color: palette.fg }}
    >
      {frame.lines.map((line, row) => (
        <span key={row} className="block whitespace-pre">
          {line.map((span, at) => (
            <span key={at} style={{ color: palette[span.ink] }}>
              {span.text}
            </span>
          ))}
          {frame.cursor && row === last ? (
            <span
              className="inline-block h-[1.1em] w-[0.6em] align-[-0.2em]"
              style={{ background: palette.cursor }}
            />
          ) : null}
        </span>
      ))}
    </span>
  );
}

/**
 * A theme as a small terminal, typing — see `lib/terminalPreview.ts` for why a
 * terminal rather than its colours. For the theme grids, where a cell is big
 * enough to read; the tab menu's swatches are a few pixels across and stay as
 * hues.
 *
 * `system` is the two foundations on one terminal, split on a slant: Midnight
 * on the left, Paper on the right. A slant well left of centre, because the
 * text sits at the left and a split down the middle left Paper's half empty.
 */
function TerminalSwatch({ theme, className }: { theme: Theme | null; className?: string }) {
  const reduced = prefersStill();
  const now = useSyncExternalStore(reduced ? still : subscribeTick, readTick, readTick);
  const id = theme?.id ?? "system";
  const frame = reduced ? finalFrame() : frameAt(now + offsetFor(id));

  const dark = themeById("dark");
  const light = themeById("light");
  return (
    <span
      aria-hidden
      className={cn("relative block shrink-0 overflow-hidden border border-hairline-strong", className)}
    >
      {theme !== null ? (
        <Screen frame={frame} palette={theme.palette} />
      ) : dark && light ? (
        <>
          <Screen frame={frame} palette={dark.palette} />
          <span className="absolute inset-0" style={{ clipPath: "polygon(48% 0, 100% 0, 100% 100%, 22% 100%)" }}>
            <Screen frame={frame} palette={light.palette} />
          </span>
        </>
      ) : null}
    </span>
  );
}

export function ThemeSwatch({
  theme,
  className,
  bars = 4,
  terminal = false,
}: {
  /** `null` is `system`, which has no palette to show. */
  theme: Theme | null;
  className?: string;
  /** How many hues the still version lays down. */
  bars?: number;
  /** A typing terminal in place of the hues, where there is room to read one.
   *  A living theme is always its drawing: that is the thing being chosen. */
  terminal?: boolean;
}) {
  if (theme !== null && theme.ambient !== undefined) {
    return <AmbientSwatch theme={theme} className={className} />;
  }
  if (terminal) return <TerminalSwatch theme={theme} className={className} />;
  return <HueSwatch theme={theme} className={className} bars={bars} />;
}

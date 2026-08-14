/**
 * The drawings that run behind the panes.
 *
 * One canvas, one animation frame loop, and a table of painters. A painter is
 * handed a context, a size, a time in seconds and the palette of the theme that
 * asked for it — and it never reads a colour from anywhere else. That is the
 * whole contract, and it is what keeps a backdrop from being a second place a
 * theme is written down: change the palette and the weather changes with it.
 *
 * Three rules the painters all obey, because a backdrop is not the point of a
 * terminal:
 *
 *   - **Cheap.** The per-pixel ones (both fractals, the lava) compute into a
 *     small `ImageData` — a couple of hundred pixels across — and let the
 *     browser scale it up. At that size the result is a soft wash rather than a
 *     crisp picture, which is exactly what belongs behind text.
 *   - **Idle.** Nothing runs while the window is hidden, and
 *     `prefers-reduced-motion` gets a handful of frames to settle into a still
 *     image and then stops for good.
 *   - **Slow.** Everything here is tuned to move at the speed of weather. A
 *     backdrop that draws the eye is a backdrop that has to be turned off.
 */

import { activityLevel } from "./activity";
import type { AmbientId, Palette } from "./themes";

/** Longest side of the buffer the per-pixel painters compute into. */
const FIELD_MAX = 240;
/** Per-pixel painters recompute at this rate; the upscale runs every frame. */
const FIELD_FPS = 15;
/** Frames a reduced-motion viewer gets before the picture is left standing. */
const REDUCED_FRAMES = 90;

interface Frame {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels, not device pixels — the context is pre-scaled. */
  w: number;
  h: number;
  /** Seconds since the painter started. */
  t: number;
  colors: RGB[];
  bg: RGB;
  /** The theme's brightest colour, for the one pixel that should be hottest. */
  hi: RGB;
  /** The resolved monospace stack, since canvas cannot read a CSS variable. */
  mono: string;
}

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const v = hex.replace("#", "");
  const f =
    v.length === 3
      ? v
          .split("")
          .map((c) => c + c)
          .join("")
      : v;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

function css(c: RGB, alpha = 1): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`;
}

/**
 * A colour from a continuous ramp through the theme's accents.
 *
 * `u` wraps, so a painter can cycle through it forever without a seam. This is
 * the only way a painter is allowed to invent a colour, which is why every
 * backdrop looks like it belongs to the theme that asked for it.
 */
function ramp(colors: RGB[], u: number): RGB {
  const n = colors.length;
  const x = ((u % 1) + 1) % 1;
  const i = Math.floor(x * n);
  const f = x * n - i;
  const a = colors[i % n];
  const b = colors[(i + 1) % n];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/* ── The per-pixel scratch buffer ────────────────────────────────────────── */

/**
 * A small offscreen canvas the escape-time painters write pixels into.
 *
 * Kept beside the loop rather than inside a painter because it is resized with
 * the window and reused across frames; allocating an `ImageData` sixty times a
 * second is a good way to make a backdrop the most expensive thing in the app.
 */
interface Field {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  w: number;
  h: number;
}

function makeField(w: number, h: number): Field | null {
  const scale = FIELD_MAX / Math.max(w, h, 1);
  const fw = Math.max(2, Math.round(w * Math.min(1, scale)));
  const fh = Math.max(2, Math.round(h * Math.min(1, scale)));
  const canvas = document.createElement("canvas");
  canvas.width = fw;
  canvas.height = fh;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  return { canvas, ctx, image: ctx.createImageData(fw, fh), w: fw, h: fh };
}

/* ── Painters ────────────────────────────────────────────────────────────── */

/**
 * The escape-time pair, sharing everything but the iteration itself.
 *
 * `seed` returns the starting `z` and the constant `c` for a point on the
 * plane, which is the *only* difference between the Mandelbrot set and a Julia
 * set: Mandelbrot varies `c` and starts `z` at the origin, Julia fixes `c` and
 * starts `z` at the point. Writing it once makes that visible instead of
 * burying it in two near-identical loops.
 */
function escapeTime(
  field: Field,
  frame: Frame,
  view: { cx: number; cy: number; scale: number; iterations: number },
  seed: (x: number, y: number) => { zx: number; zy: number; cx: number; cy: number },
  shift: number,
): void {
  const { image, w, h } = field;
  const data = image.data;
  const aspect = w / h;
  const { iterations } = view;
  // Escaping past 2 is enough to prove divergence, but a larger radius makes
  // the smooth-iteration estimate below accurate — otherwise the bands show.
  // Squared, because that is the form the loop can test without a square root.
  const bailoutSq = 256;
  const logRadius = Math.log(Math.log(Math.sqrt(bailoutSq)));
  const log2 = Math.log(2);

  let p = 0;
  for (let py = 0; py < h; py++) {
    const v = (py / h - 0.5) * view.scale + view.cy;
    for (let px = 0; px < w; px++) {
      const u = (px / w - 0.5) * view.scale * aspect + view.cx;
      const s = seed(u, v);
      let zx = s.zx;
      let zy = s.zy;
      let n = 0;
      let zx2 = zx * zx;
      let zy2 = zy * zy;
      while (n < iterations && zx2 + zy2 < bailoutSq) {
        zy = 2 * zx * zy + s.cy;
        zx = zx2 - zy2 + s.cx;
        zx2 = zx * zx;
        zy2 = zy * zy;
        n++;
      }

      let c: RGB;
      if (n >= iterations) {
        // Inside the set. Left as the theme's own background so the interior
        // reads as a hole in the picture rather than as another colour.
        c = frame.bg;
      } else {
        // Smooth iteration count: the fractional part of how far past the
        // bailout the orbit went, which turns the integer bands into a ramp.
        const mu = n + 1 - (Math.log(Math.log(Math.sqrt(zx2 + zy2))) - logRadius) / log2;
        c = ramp(frame.colors, mu * 0.035 + shift);
      }
      data[p++] = c[0];
      data[p++] = c[1];
      data[p++] = c[2];
      data[p++] = 255;
    }
  }
  field.ctx.putImageData(image, 0, 0);
}

/**
 * A breath in and out of the set, rather than an endless zoom.
 *
 * An endless zoom has to reset, and the reset is a jump-cut in the corner of
 * your eye every couple of minutes. Breathing has no seam: it arrives at the
 * deep end, hangs there, and comes back out. The target is one of the
 * well-known points on the boundary, where there is always more structure.
 */
function mandelbrot(field: Field, frame: Frame): void {
  const breath = 0.5 * (1 - Math.cos(frame.t * 0.045));
  escapeTime(
    field,
    frame,
    {
      cx: -0.743643887037151,
      cy: 0.13182590420533,
      // Roughly seven hundred times in, and no further. Depth here is not free:
      // past what the iteration cap below can resolve, more zoom does not buy
      // more detail, it buys a screen that is uniformly "still inside the set"
      // — which is to say a blank one. This is about as deep as 220 iterations
      // can actually draw.
      scale: 3.2 * Math.pow(1.5e-3, breath),
      // More of them as it goes deeper, because the detail that makes a zoom
      // worth looking at is exactly what a low cap erases.
      iterations: Math.round(90 + breath * 130),
    },
    (x, y) => ({ zx: 0, zy: 0, cx: x, cy: y }),
    frame.t * 0.02,
  );
}

/** The constant walks a circle, so the shape turns itself inside out forever. */
function julia(field: Field, frame: Frame): void {
  const a = frame.t * 0.035;
  // Radius 0.7885 is the classic tour: the circle crosses in and out of the
  // Mandelbrot set, so the Julia set alternately connects and shatters.
  const cx = 0.7885 * Math.cos(a);
  const cy = 0.7885 * Math.sin(a);
  escapeTime(
    field,
    frame,
    { cx: 0, cy: 0, scale: 3.0, iterations: 120 },
    (x, y) => ({ zx: x, zy: y, cx, cy }),
    frame.t * 0.03,
  );
}

/**
 * Metaballs, computed rather than blurred.
 *
 * The usual trick for these is a heavy blur and a contrast curve, which needs
 * `ctx.filter` — not something to rely on across three different webviews. At
 * this buffer size the honest field is only a few hundred thousand multiplies,
 * so it is computed directly and the merging is real.
 */
function lava(field: Field, frame: Frame): void {
  const { image, w, h } = field;
  const data = image.data;
  const t = frame.t * 0.12;
  const balls: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const p = i * 1.7;
    balls.push({
      x: (0.5 + 0.38 * Math.sin(t * (0.5 + i * 0.09) + p)) * w,
      // Slower vertically, and biased low: the blobs should feel heavy.
      y: (0.55 + 0.42 * Math.cos(t * (0.31 + i * 0.07) + p * 1.3)) * h,
      r: (0.1 + 0.055 * Math.sin(t * 0.4 + p)) * Math.min(w, h),
    });
  }

  let p = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (const b of balls) {
        const dx = x - b.x;
        const dy = y - b.y;
        sum += (b.r * b.r) / (dx * dx + dy * dy + 1);
      }
      // Inside a blob the field is above 1; the ramp below that is the halo.
      const heat = Math.min(1, sum * 0.62);
      const c = ramp(frame.colors, heat * 0.85 + frame.t * 0.01);
      const k = heat * heat;
      data[p++] = frame.bg[0] + (c[0] - frame.bg[0]) * k;
      data[p++] = frame.bg[1] + (c[1] - frame.bg[1]) * k;
      data[p++] = frame.bg[2] + (c[2] - frame.bg[2]) * k;
      data[p++] = 255;
    }
  }
  field.ctx.putImageData(image, 0, 0);
}

/**
 * Curtains: several stacked sine bands, each drawn as a vertical gradient and
 * added to what is under it. Additive rather than painted over, because that is
 * what light does and it is why the overlaps are the bright parts.
 */
function aurora(frame: Frame): void {
  const { ctx, w, h, t, colors } = frame;
  ctx.fillStyle = css(frame.bg);
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";

  for (let band = 0; band < 5; band++) {
    const c = ramp(colors, band / 5 + t * 0.012);
    const phase = t * (0.09 + band * 0.017) + band * 2.1;
    const amp = h * (0.05 + band * 0.014);
    const mid = h * (0.28 + band * 0.1);
    const thickness = h * (0.16 + band * 0.05);

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 12) {
      const u = x / w;
      const y =
        mid +
        Math.sin(u * 3.1 + phase) * amp +
        Math.sin(u * 7.7 - phase * 1.4) * amp * 0.45 +
        Math.sin(u * 1.3 + phase * 0.6) * amp * 0.8;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, mid - thickness, 0, mid + thickness * 1.6);
    gradient.addColorStop(0, css(c, 0));
    gradient.addColorStop(0.35, css(c, 0.26));
    gradient.addColorStop(1, css(c, 0));
    ctx.fillStyle = gradient;
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/**
 * A flower that never finishes rearranging itself.
 *
 * Seeds are placed the way a sunflower places them: the *n*th at angle
 * `n × divergence` and radius `√n`, which packs them evenly with no gaps and
 * no seams — the arrangement a real head arrives at, and the reason one looks
 * the way it does. At the golden angle the seeds never line up, so the eye
 * invents spiral arms out of near-alignments instead, and counts them in
 * Fibonacci numbers because those are the fractions closest to the golden
 * ratio.
 *
 * The motion is one number. The divergence drifts by about a tenth of a degree
 * either side of golden, and that is enough to swap which near-alignments the
 * eye finds: the arms unwind, reverse, and rewind the other way, forever,
 * without anything ever moving quickly. It is a very large visual change bought
 * with a very small one, which is exactly the trade a backdrop wants.
 *
 * Drawn straight to the canvas rather than through the pixel buffer. This is a
 * few hundred discs, not a few hundred thousand samples, and discs at real
 * resolution keep the crisp centre a scaled-up buffer would lose.
 */
function bloom(frame: Frame): void {
  const { ctx, w, h, t, colors } = frame;
  ctx.fillStyle = css(frame.bg);
  ctx.fillRect(0, 0, w, h);

  // 137.507…°, the golden angle, in radians.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const divergence = GOLDEN + 0.0021 * Math.sin(t * 0.031);

  const seeds = 620;
  const cx = w / 2;
  const cy = h / 2;
  // Reaches past the shorter edge, so the head is cropped by the window rather
  // than floating in the middle of it with a margin all round — a backdrop
  // should look like a window onto something bigger.
  const spread = (Math.max(w, h) * 0.62) / Math.sqrt(seeds);
  const spin = t * 0.02;
  // Six lobes of brightness laid over the spiral, which is what reads as
  // "flower" rather than "seed head".
  const petals = 6;

  ctx.globalCompositeOperation = "lighter";
  for (let i = 1; i <= seeds; i++) {
    const a = i * divergence + spin;
    const r = spread * Math.sqrt(i);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    // Cheap reject: the corners are the only part outside, and skipping them
    // is most of the head once the window is wide.
    if (x < -8 || x > w + 8 || y < -8 || y > h + 8) continue;

    const u = i / seeds;
    // Bigger further out, the way the florets of a real head are.
    const size = (0.6 + u * 2.6) * Math.max(1, Math.min(w, h) / 190);
    const petal = 0.55 + 0.45 * Math.cos(a * petals - t * 0.08);
    // Faded at the rim so the head has no hard edge to it.
    const alpha = 0.52 * petal * (1 - u * 0.45);

    ctx.fillStyle = css(ramp(colors, u * 0.55 + t * 0.01), alpha);
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // The heart of it: one soft light where the newest florets are, in the
  // theme's brightest colour, so the middle is where the eye settles.
  const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.22);
  heart.addColorStop(0, css(frame.hi, 0.16));
  heart.addColorStop(1, css(frame.hi, 0));
  ctx.fillStyle = heart;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = "source-over";
}

/* ── Painters that keep state between frames ─────────────────────────────── */

/**
 * A painter that owns something across frames — a buffer, a swarm, a set of
 * columns. `reset` is called when the canvas changes size, at which point all
 * of that is measured in the wrong units and has to be built again.
 */
interface Painter {
  paint(frame: Frame): void;
  reset(): void;
}

/**
 * The clouds.
 *
 * Particles are advected by a time-varying flow field and smeared into a
 * persistent low-resolution buffer that fades slightly each frame. The fade is
 * what makes it read as cloud rather than as a swarm of dots: what you see is
 * where the particles have *been*, not where they are.
 */
function makeNebula(): Painter {
  let field: Field | null = null;
  let dots: { x: number; y: number; vx: number; vy: number; r: number; slot: number }[] = [];

  const reset = () => {
    field = null;
    dots = [];
  };

  const paint = (frame: Frame) => {
    if (field === null) field = makeField(frame.w, frame.h);
    if (field === null) return;
    const { ctx: fctx, w, h } = field;

    if (dots.length === 0) {
      fctx.fillStyle = css(frame.bg);
      fctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {
        dots.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: 0,
          vy: 0,
          r: 8 + Math.random() * 22,
          slot: i % Math.max(1, frame.colors.length),
        });
      }
    }

    // A slow bleed back to the background, so the trails have a finite life
    // and the buffer never saturates.
    fctx.globalCompositeOperation = "source-over";
    fctx.fillStyle = css(frame.bg, 0.035);
    fctx.fillRect(0, 0, w, h);

    fctx.globalCompositeOperation = "lighter";
    const t = frame.t;
    for (const d of dots) {
      // A curl-ish field: two sines whose arguments contain each other, which
      // is enough to make streams that fold rather than flow straight.
      const nx = d.x / w;
      const ny = d.y / h;
      const fx = Math.sin(ny * 7.4 + Math.sin(nx * 4.1 + t * 0.17) * 1.6 - t * 0.1);
      const fy = Math.sin(nx * 6.3 - Math.sin(ny * 5.0 - t * 0.14) * 1.4 + t * 0.12);
      d.vx = d.vx * 0.94 + fx * 0.09;
      d.vy = d.vy * 0.94 + fy * 0.09;
      d.x += d.vx;
      d.y += d.vy;
      // Wrapped rather than bounced: an edge the clouds pile against would be
      // the most visible thing in the picture.
      if (d.x < -d.r) d.x = w + d.r;
      if (d.x > w + d.r) d.x = -d.r;
      if (d.y < -d.r) d.y = h + d.r;
      if (d.y > h + d.r) d.y = -d.r;

      const c = ramp(frame.colors, d.slot / frame.colors.length + t * 0.008);
      const g = fctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
      g.addColorStop(0, css(c, 0.05));
      g.addColorStop(1, css(c, 0));
      fctx.fillStyle = g;
      fctx.fillRect(d.x - d.r, d.y - d.r, d.r * 2, d.r * 2);
    }
    fctx.globalCompositeOperation = "source-over";

    frame.ctx.drawImage(field.canvas, 0, 0, frame.w, frame.h);
  };

  return { paint, reset };
}

/** Glyphs falling in columns, brightest at the head of each stream. */
function makeRain(): Painter {
  const CELL = 15;
  // Katakana, digits and a few symbols — the alphabet the effect is known by.
  const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ0123456789:.=*+-<>";
  let columns: { y: number; speed: number; length: number }[] = [];

  const reset = () => {
    columns = [];
  };

  const paint = (frame: Frame) => {
    const { ctx, w, h, colors } = frame;
    const count = Math.max(1, Math.ceil(w / CELL));
    if (columns.length !== count) {
      columns = Array.from({ length: count }, () => ({
        // Scattered down the screen at the start rather than all at the top,
        // so the first second is rain rather than a curtain dropping.
        y: Math.random() * (h / CELL),
        speed: 0.1 + Math.random() * 0.22,
        length: 8 + Math.floor(Math.random() * 18),
      }));
    }

    ctx.fillStyle = css(frame.bg);
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${CELL - 2}px ${frame.mono}`;
    ctx.textBaseline = "top";

    const tail = ramp(colors, 0.35);
    for (let i = 0; i < count; i++) {
      const col = columns[i];
      col.y += col.speed;
      if ((col.y - col.length) * CELL > h) {
        col.y = -Math.random() * 20;
        col.speed = 0.1 + Math.random() * 0.22;
        col.length = 8 + Math.floor(Math.random() * 18);
      }
      const tip = Math.floor(col.y);
      for (let j = 0; j < col.length; j++) {
        const row = tip - j;
        if (row < 0 || row * CELL > h) continue;
        // The glyph is chosen from the cell's own coordinates, so a column
        // holds still as it falls instead of flickering into noise.
        const glyph = GLYPHS[(i * 31 + row * 17 + Math.floor(frame.t * 2)) % GLYPHS.length];
        const fade = 1 - j / col.length;
        ctx.fillStyle = j === 0 ? css(frame.hi, 0.85) : css(tail, fade * fade * 0.5);
        ctx.fillText(glyph, i * CELL, row * CELL);
      }
    }
  };

  return { paint, reset };
}

/** Stars streaming past, drawn as streaks so the speed is visible. */
function makeWarp(): Painter {
  let stars: { x: number; y: number; z: number; slot: number }[] = [];

  // Nothing here is measured in pixels — a star is a direction and a depth —
  // so a resize costs it nothing and there is nothing to throw away.
  const reset = () => {};

  const paint = (frame: Frame) => {
    const { ctx, w, h, colors, t } = frame;
    if (stars.length === 0) {
      stars = Array.from({ length: 320 }, (_, i) => ({
        x: Math.random() * 2 - 1,
        y: Math.random() * 2 - 1,
        z: Math.random(),
        slot: i % Math.max(1, colors.length),
      }));
    }

    ctx.fillStyle = css(frame.bg);
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const reach = Math.max(w, h) * 0.62;
    // Breathes between a drift and a run, so it is not one constant speed.
    const speed = 0.0016 + 0.0022 * (0.5 - 0.5 * Math.cos(t * 0.06));

    for (const s of stars) {
      s.z -= speed;
      if (s.z <= 0.01) {
        s.x = Math.random() * 2 - 1;
        s.y = Math.random() * 2 - 1;
        s.z = 1;
      }
      const k = 1 / s.z;
      const px = cx + s.x * reach * k;
      const py = cy + s.y * reach * k;
      if (px < -50 || px > w + 50 || py < -50 || py > h + 50) continue;

      // The streak is where the star was one step ago, which is what makes
      // the near ones long and the far ones points.
      const kp = 1 / (s.z + speed * 7);
      const qx = cx + s.x * reach * kp;
      const qy = cy + s.y * reach * kp;

      const near = 1 - s.z;
      ctx.strokeStyle = css(ramp(colors, s.slot / colors.length), 0.15 + near * 0.5);
      ctx.lineWidth = 0.4 + near * 1.6;
      ctx.beginPath();
      ctx.moveTo(qx, qy);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
  };

  return { paint, reset };
}

/* ── The loop ────────────────────────────────────────────────────────────── */

/* ── The table of painters ───────────────────────────────────────────────── */

/** The three shapes a painter comes in. See the three sections above. */
type Slot =
  | { kind: "stateful"; make: () => Painter }
  | { kind: "direct"; draw: (frame: Frame) => void }
  | { kind: "buffered"; draw: (field: Field, frame: Frame) => void };

/**
 * Every painter, by the id that asks for it.
 *
 * `Record<AmbientId, Slot>` is the whole point of the table: adding an id to
 * the union and forgetting to draw it is a compile error here. This replaced a
 * chain of `else if` that ended in `else lava(…)`, where the same mistake was
 * silent — a new living theme simply drew a lava lamp in its own colours, which
 * looks enough like a working feature to ship.
 */
const PAINTERS: Record<AmbientId, Slot> = {
  nebula: { kind: "stateful", make: makeNebula },
  rain: { kind: "stateful", make: makeRain },
  warp: { kind: "stateful", make: makeWarp },
  aurora: { kind: "direct", draw: aurora },
  bloom: { kind: "direct", draw: bloom },
  mandelbrot: { kind: "buffered", draw: mandelbrot },
  julia: { kind: "buffered", draw: julia },
  lava: { kind: "buffered", draw: lava },
};

/**
 * Start drawing `id` on `canvas` in `palette`'s colours. Returns the stop.
 *
 * Everything the loop owns — the buffers, the particles, the listeners — is
 * created inside this call and released by the returned function, so changing
 * theme is a stop and a start rather than a reconfiguration. A backdrop is
 * cheap enough to rebuild, and nothing about the old one should survive into
 * the new one's colours.
 */
/** What the viewer has asked of the backdrop, over what the theme asked for. */
export interface AmbientTuning {
  /** Speed multiplier. `0` stops the drawing and leaves it as a wallpaper. */
  motion: number;
  /** How much the shells' own output speeds it up. `0` is a plain clock. */
  activity: number;
}

const STEADY: AmbientTuning = { motion: 1, activity: 1 };

/**
 * `tuning` is a *getter*, read once per frame, rather than a value.
 *
 * Dragging a slider changes it sixty times a second, and a value would mean
 * sixty restarts — each one throwing away the pixel buffer, the particles and
 * the picture built up in them. Read per frame, the same drag is free and the
 * backdrop simply changes speed under the pointer.
 */
export function startAmbient(
  canvas: HTMLCanvasElement,
  id: AmbientId,
  palette: Palette,
  tuning: () => AmbientTuning = () => STEADY,
): () => void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (ctx === null) return () => {};

  // The eight hues a theme actually uses to mean something, in a sensible
  // order round the wheel, plus the background at each end so a ramp through
  // them settles into the theme rather than ending on a stray colour.
  const colors: RGB[] = [
    palette.blue,
    palette.cyan,
    palette.green,
    palette.yellow,
    palette.red,
    palette.magenta,
    palette.brightBlue,
    palette.brightMagenta,
  ].map(rgb);
  const bg = rgb(palette.bg);
  const hi = rgb(palette.brightWhite);
  const mono =
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    "monospace";

  const slot = PAINTERS[id];
  const painter: Painter | null = slot.kind === "stateful" ? slot.make() : null;

  let field: Field | null = null;
  let width = 0;
  let height = 0;
  let raf = 0;
  let stopped = false;
  let painted = 0;
  let fieldAt = -Infinity;
  /**
   * The painters' clock, which is *not* the wall clock.
   *
   * Time is accumulated at a rate the viewer controls rather than read from
   * `now`, because the two behave completely differently when the rate changes:
   * scaling elapsed wall time would make every painter jump — a fractal that
   * has been zooming for ten minutes would snap somewhere else the moment the
   * slider moved — while accumulating simply carries on from where it is at the
   * new speed. It is also what lets `motion: 0` mean "hold this picture" rather
   * than "go back to the beginning".
   */
  let clock = 0;
  let tick = 0;

  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function schedule(): void {
    if (stopped || raf !== 0) return;
    raf = requestAnimationFrame(draw);
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === width && h === height) return;
    width = w;
    height = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Everything measured in pixels was measured against the old size.
    field = null;
    fieldAt = -Infinity;
    painter?.reset();
    // A resize threw the picture away; a reduced-motion viewer needs a fresh
    // budget, or they are left looking at a stretched old frame forever.
    painted = 0;
    schedule();
  }

  function draw(now: number): void {
    raf = 0;
    if (stopped) return;
    schedule();

    // Nothing to look at, so nothing to draw. The frame callback still fires
    // in some webviews when the window is behind another one.
    if (document.hidden || width === 0) return;

    // Advance the painters' clock. `dt` is clamped because a window that has
    // been behind another one for a minute comes back with a minute's gap, and
    // handing that to a painter would jump the picture exactly as hard as
    // scaling wall time would.
    const dt = tick === 0 ? 0 : Math.min(0.1, (now - tick) / 1000);
    tick = now;
    // The shells' own busyness, but only as far as the viewer asked for it.
    // At `activity: 0` this is the plain clock every living theme had before.
    const { motion, activity } = tuning();
    const busy = activity === 0 ? 0 : activityLevel(now) * activity;
    clock += dt * motion * (1 + busy);

    // A backdrop that is not moving is a wallpaper. The accumulating painters
    // still need a few passes to build their picture, so it settles first and
    // is then simply held — which costs one comparison a frame instead of
    // repainting an identical image, and leaves the loop live so that raising
    // Motion picks straight up rather than needing a restart.
    //
    // `motion: 0` has to be caught here rather than by leaving `clock` alone,
    // because the particle painters advance their swarms per *frame* and would
    // carry on drifting under a stopped clock.
    if ((reduced || motion === 0) && painted >= REDUCED_FRAMES) return;

    const frame: Frame = {
      ctx: ctx!,
      w: width,
      h: height,
      t: clock,
      colors,
      bg,
      hi,
      mono,
    };

    if (painter !== null) {
      painter.paint(frame);
    } else if (slot.kind === "direct") {
      slot.draw(frame);
    } else if (slot.kind === "buffered") {
      // Recomputed on a slower clock than the screen's and blitted every
      // frame, which is invisible at this scale and is the difference between
      // a backdrop and a fan coming on.
      if (field === null) field = makeField(width, height);
      if (field === null) return;
      if (now - fieldAt >= 1000 / FIELD_FPS) {
        fieldAt = now;
        slot.draw(field, frame);
      }
      ctx!.imageSmoothingEnabled = true;
      ctx!.imageSmoothingQuality = "high";
      ctx!.drawImage(field.canvas, 0, 0, width, height);
    }

    painted++;
  }

  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
  observer?.observe(canvas);
  window.addEventListener("resize", resize);

  resize();
  schedule();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    raf = 0;
    observer?.disconnect();
    window.removeEventListener("resize", resize);
  };
}

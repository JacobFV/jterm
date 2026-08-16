import type { AmbientTuning } from "./ambient";
import type { Palette } from "./themes";

/**
 * Exact canvas translation of @yuruyurau's compact Processing/p5 formula.
 * Geometry is formula-driven; only the raster plumbing differs from p5.
 */
export function startFormulaAmbient(
  canvas: HTMLCanvasElement,
  palette: Palette,
  tuning: () => AmbientTuning,
): () => void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (ctx === null) return () => {};

  let width = 0;
  let height = 0;
  let raf = 0;
  let stopped = false;
  let phase = 0;
  let last = 0;

  const bg = palette.bg;
  const dot = palette.brightWhite;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(now: number): void {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;

    resize();

    const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    const motion = Math.max(0, tuning().motion);
    // Original sketch increments t by PI/80 per rendered frame. 60 fps is
    // therefore 60*PI/80 rad/s; multiply by the app's Motion setting.
    phase += dt * (60 * Math.PI / 80) * motion;

    ctx!.fillStyle = bg;
    ctx!.fillRect(0, 0, width, height);
    ctx!.fillStyle = dot;
    ctx!.globalAlpha = 96 / 255;

    // Original coordinate system is 400x400. Preserve it and fit-center it in
    // arbitrary panes instead of distorting the formula independently in x/y.
    const s = Math.min(width, height) / 400;
    const ox = (width - 400 * s) / 2;
    const oy = (height - 400 * s) / 2;

    for (let i = 10000; i--;) {
      const y = i / 253;
      const k = 5 * Math.cos(i / 44);
      const e = y / 2 - 15;
      const d = Math.hypot(k, e) / 3;
      const c = d / 2 - phase / 3 + (i % 2) * 3;

      const x =
        (79 + d * d + k * k) * Math.sin(c) +
        200 +
        (d * d * d) / 4 * Math.cos(phase * 3 - (d * d) / 4);

      const yy =
        99 * Math.cos(c / 2) +
        4 * Math.sin(k * 2) +
        (y / (77 * Math.sin(e / 2) + 1e-4)) * k * e +
        200;

      if (!Number.isFinite(x) || !Number.isFinite(yy)) continue;
      const px = ox + x * s;
      const py = oy + yy * s;
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      ctx!.fillRect(px, py, Math.max(0.7, s), Math.max(0.7, s));
    }
    ctx!.globalAlpha = 1;
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  raf = requestAnimationFrame(draw);

  return () => {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(raf);
  };
}

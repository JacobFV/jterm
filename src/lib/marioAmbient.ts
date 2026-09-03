import type { AmbientTuning } from "./ambient";
import type { Palette } from "./themes";

/**
 * An 8-bit side-scroller that never ends: a plumber runs right forever
 * through a course generated on the fly from a hash of how far he has gone,
 * so the same run is never seen twice but never needs to be remembered
 * either. Lives in its own module, like the Formula theme, so the shared
 * painter table in `ambient.ts` stays a place for cheap washes of colour and
 * this stays auditable on its own.
 */
export function startMarioAmbient(
  canvas: HTMLCanvasElement,
  _palette: Palette,
  tuning: () => AmbientTuning,
): () => void {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (ctx === null) return () => {};

  let width = 0;
  let height = 0;
  let raf = 0;
  let stopped = false;
  let last = 0;
  let worldX = 0; // camera position, in tiles
  let clock = 0; // seconds, for leg/waddle animation and behaviour chapters
  let facing = 1; // -1 or 1; sticky across frames so idle/hop don't spin him around

  /* ── Palette ─────────────────────────────────────────────────────────── */
  const SKY = "#5c94fc";
  const HILL_A = "#00a800";
  const HILL_B = "#049a1c";
  const CLOUD = "#fcfcfc";
  const GROUND = "#c84c0c";
  const GROUND_DARK = "#a03c08";
  const GROUND_EDGE = "#e88030";
  const VOID = "#050608";
  const PIPE = "#00a800";
  const PIPE_DARK = "#00701c";
  const BRICK = "#b85c1c";
  const BRICK_DARK = "#7c3a0e";

  /**
   * Mario and the Goomba are pixel-exact, not procedural: each row string
   * below is a pixel of the real NES sprite, traced from a ripped sheet
   * (spriters-resource.com, Super Mario Bros., "Mario & Luigi" / "Ground
   * Enemies") one pixel at a time. Everything else in this file (blocks,
   * pipes, hills, ground) is cheap enough to draw as flat rects and still
   * read as itself; a running plumber and a stomping mushroom are not, so
   * they get the real bitmap instead of an approximation of one.
   */
  const MARIO_PALETTE: Record<string, string> = { R: "#b53120", O: "#6b4a1a", S: "#eaa022" };
  const MARIO_STAND = [
    "..............",
    "....RRRRR.....",
    "...RRRRRRRRR..",
    "...OOOSSOS....",
    "..OSOSSSOSSS..",
    "..OSOOSSSOSSS.",
    "..OOSSSSOOOO..",
    "....SSSSSSS...",
    "...OOROOO.....",
    "..OOOROOROOO..",
    ".OOOORRRROOOO.",
    ".SSORSRRSROSS.",
    ".SSSRRRRRRSSS.",
    ".SSRRRRRRRRSS.",
    "...RRR..RRR...",
    "..OOO....OOO..",
    ".OOOO....OOOO.",
    "..............",
  ];
  const MARIO_RUN_A = [
    ".................",
    "......RRRRR......",
    ".....RRRRRRRRR...",
    ".....OOOSSOS.....",
    "....OSOSSSOSSS...",
    "....OSOOSSSOSSS..",
    "....OOSSSSOOOO...",
    "......SSSSSSS....",
    "...OOOORROO......",
    ".SSOOOORRROOOSSS.",
    ".SSS.OORSRRROOSS.",
    ".SS..RRRRRRR..O..",
    "....RRRRRRRRROO..",
    "...RRRRRRRRRROO..",
    "..OORRR...RRROO..",
    "..OOO............",
    "...OOO...........",
    ".................",
  ];
  const MARIO_RUN_B = [
    ".............",
    "...RRRRR.....",
    "..RRRRRRRRR..",
    "..OOOSSOS....",
    ".OSOSSSOSSS..",
    ".OSOOSSSOSSS.",
    ".OOSSSSOOOO..",
    "...SSSSSSS...",
    "..OOROOO.....",
    ".OOOORROO....",
    ".OOORRSRRS...",
    ".OOOORRRRR...",
    ".ROOSSSRRR...",
    "..ROSSRRR....",
    "...RRROOO....",
    "...OOOOOOO...",
    "...OOOO......",
    ".............",
  ];

  const GOOMBA_PALETTE: Record<string, string> = { B: "#9c4a00", F: "#ffcec5", K: "#101010" };
  const GOOMBA_A = [
    "..................",
    ".......BBBB.......",
    "......BBBBBB......",
    ".....BBBBBBBB.....",
    "....BBBBBBBBBB....",
    "...BKKBBBBBBKKB...",
    "..BBBFKBBBBKFBBB..",
    "..BBBFKKKKKKFBBB..",
    ".BBBBFKFBBFKFBBBB.",
    ".BBBBFFFBBFFFBBBB.",
    ".BBBBBBBBBBBBBBBB.",
    "..BBBBFFFFFFBBBB..",
    ".....FFFFFFFF.....",
    ".....FFFFFFFFKK...",
    "....KKFFFFFKKKKK..",
    "....KKKFFFKKKKKK..",
    ".....KKK..KKKKK...",
    "..................",
  ];
  const GOOMBA_B = [
    "..................",
    ".......BBBB.......",
    "......BBBBBB......",
    ".....BBBBBBBB.....",
    "....BBBBBBBBBB....",
    "...BKKBBBBBBKKB...",
    "..BBBFKBBBBKFBBB..",
    "..BBBFKKKKKKFBBB..",
    ".BBBBFKFBBFKFBBBB.",
    ".BBBBFFFBBFFFBBBB.",
    ".BBBBBBBBBBBBBBBB.",
    "..BBBBFFFFFFBBBB..",
    ".....FFFFFFFF.....",
    "...KKFFFFFFFF.....",
    "..KKKKKFFFFFKK....",
    "..KKKKKKFFFKKK....",
    "...KKKKK..KKK.....",
    "..................",
  ];

  /** Same deal, traced from the sheet's "Item and Brick Blocks" asset. */
  const QBLOCK_PALETTE: Record<string, string> = { D: "#9c4a00", Y: "#e79c21", K: "#000000" };
  const QBLOCK = [
    "DDDDDDDDDDDDDDDK",
    "DYYYYYYYYYYYYYYK",
    "DYKYYYYYYYYYYKYK",
    "DYYYYDDDDDYYYYYK",
    "DYYYDDKKKDDYYYYK",
    "DYYYDDKYYDDKYYYK",
    "DYYYDDKYYDDKYYYK",
    "DYYYYKKYDDDKYYYK",
    "DYYYYYYDDKKKYYYK",
    "DYYYYYYDDKYYYYYK",
    "DYYYYYYYKKYYYYYK",
    "DYYYYYYDDYYYYYYK",
    "DYYYYYYDDKYYYYYK",
    "DYKYYYYYKKYYYKYK",
    "DYYYYYYYYYYYYYYK",
    "KKKKKKKKKKKKKKKK",
  ];

  /* ── World layout ────────────────────────────────────────────────────── */
  const ROWS = 9; // fixed vertical tile count; the pane's height is fit to it
  const GROUND_ROWS = 2;
  const OBSTACLE_PERIOD = 6; // tiles between potential ground hazards
  const BLOCK_PERIOD = 4; // tiles between potential floating blocks
  const HILL_PERIOD = 13;
  const CLOUD_PERIOD = 9;
  const JUMP_WINDOW = 1.5;
  const JUMP_HEIGHT = 2.3;
  const MARIO_X = 5; // mario's fixed position, in tiles from the pane's left edge
  const SCROLL = 3.4; // tiles per second at motion = 1
  const CHAPTER_LEN = 4.5; // seconds each behaviour chapter lasts
  const HOP_PERIOD = 0.62; // seconds per up-down hop, while hopping

  /** Deterministic pseudo-random in [0, 1) for an integer seed. */
  function hash(n: number): number {
    const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fill(x: number, y: number, w: number, h: number, color: string): void {
    ctx!.fillStyle = color;
    ctx!.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }

  /** A rounded, quantized blob: horizontal strips whose width follows a circle. */
  function dome(cx: number, baseY: number, r: number, cell: number, color: string): void {
    ctx!.fillStyle = color;
    for (let ry = 0; ry < r; ry += cell) {
      const w = Math.sqrt(Math.max(0, r * r - ry * ry));
      ctx!.fillRect(Math.round(cx - w), Math.round(baseY - ry - cell), Math.round(w * 2), cell + 1);
    }
  }

  /**
   * A traced sprite, blown up: one `cell`-sized rect per pixel, centred on
   * `cx` and standing on `baseY`. `flip` mirrors it left-right, for Mario
   * facing the way he is actually walking.
   */
  function blit(
    cx: number,
    baseY: number,
    rows: string[],
    palette: Record<string, string>,
    cell: number,
    flip = false,
  ): void {
    const h = rows.length;
    const w = rows[0]?.length ?? 0;
    const left = cx - (w * cell) / 2;
    const top = baseY - h * cell;
    for (let r = 0; r < h; r++) {
      const row = rows[r];
      for (let c = 0; c < w; c++) {
        const color = palette[row[flip ? w - 1 - c : c]];
        if (color === undefined) continue;
        fill(left + c * cell, top + r * cell, cell + 0.5, cell + 0.5, color);
      }
    }
  }

  type Obstacle =
    | { kind: "goomba"; at: number }
    | { kind: "pit"; at: number }
    | { kind: "pipe"; at: number; h: number };

  function obstacleAt(period: number): Obstacle | null {
    const r = hash(period);
    if (r < 0.42) return null;
    const at = period * OBSTACLE_PERIOD + OBSTACLE_PERIOD / 2 + (hash(period + 500) - 0.5) * 1.4;
    if (r < 0.68) return { kind: "goomba", at };
    if (r < 0.86) return { kind: "pit", at };
    return { kind: "pipe", at, h: 1 + Math.floor(hash(period + 900) * 3) };
  }

  function blockAt(period: number): { brick: boolean; at: number; row: number } | null {
    const r = hash(period * 7 + 3);
    if (r < 0.55) return null;
    const at = period * BLOCK_PERIOD + BLOCK_PERIOD / 2;
    const row = 3 + Math.floor(hash(period * 13 + 9) * 3);
    return { brick: r >= 0.8, at, row };
  }

  function draw(now: number): void {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;

    resize();

    const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    const motion = Math.max(0, tuning().motion);
    clock += dt * Math.max(motion, motion > 0 ? 0.35 : 0); // legs keep moving at low motion, stop at zero

    /**
     * What Mario is doing right now, chosen a whole chapter at a time rather
     * than per frame — a hash of the chapter index, so it is exactly as
     * reproducible as everything else here, just on a much slower clock. Most
     * chapters are an ordinary run; the rest are why he does not read as a
     * flip-book of the same four frames forever: doubling back the way he
     * came, stopping to glance around, or hopping in place under a block like
     * he is trying to reach it.
     */
    const chapterIndex = Math.floor(clock / CHAPTER_LEN);
    const chapterT = clock - chapterIndex * CHAPTER_LEN;
    const cr = hash(chapterIndex * 7 + 11);
    const behaviour: "run" | "reverse" | "idle" | "hop" =
      cr < 0.52 ? "run" : cr < 0.68 ? "idle" : cr < 0.85 ? "reverse" : "hop";
    const dir = behaviour === "run" ? 1 : behaviour === "reverse" ? -1 : 0;
    worldX += dt * SCROLL * motion * dir;
    if (dir !== 0) facing = dir;
    // Idle is also when he looks around, since there is nowhere else to put it.
    if (behaviour === "idle") facing = Math.floor(chapterT / 1.3) % 2 === 0 ? 1 : -1;

    const unit = height / ROWS;
    const groundTopY = height - GROUND_ROWS * unit;
    const tilesVisible = width / unit;

    fill(0, 0, width, height, SKY);

    /* ── Parallax hills ──────────────────────────────────────────────── */
    const hillCam = worldX * 0.35;
    const firstHill = Math.floor((hillCam - 2) / HILL_PERIOD);
    const lastHill = Math.ceil((hillCam + tilesVisible + 2) / HILL_PERIOD);
    for (let i = firstHill; i <= lastHill; i++) {
      const at = i * HILL_PERIOD + HILL_PERIOD / 2 + (hash(i + 40) - 0.5) * 4;
      const r = (2.6 + hash(i + 41) * 2.2) * unit;
      const cx = (at - hillCam) * unit;
      dome(cx, groundTopY + unit * 0.4, r, Math.max(1, unit / 6), i % 2 === 0 ? HILL_A : HILL_B);
    }

    /* ── Parallax clouds ─────────────────────────────────────────────── */
    const cloudCam = worldX * 0.55;
    const firstCloud = Math.floor((cloudCam - 2) / CLOUD_PERIOD);
    const lastCloud = Math.ceil((cloudCam + tilesVisible + 2) / CLOUD_PERIOD);
    for (let i = firstCloud; i <= lastCloud; i++) {
      const at = i * CLOUD_PERIOD + CLOUD_PERIOD / 2 + (hash(i + 70) - 0.5) * 3;
      const cy = unit * (1.2 + hash(i + 71) * 1.4);
      const cx = (at - cloudCam) * unit;
      const cell = Math.max(1, unit / 6);
      dome(cx - unit * 0.6, cy, unit * 0.6, cell, CLOUD);
      dome(cx + unit * 0.1, cy - unit * 0.15, unit * 0.75, cell, CLOUD);
      dome(cx + unit * 0.9, cy, unit * 0.55, cell, CLOUD);
    }

    /* ── Ground, textured, cut by pits ──────────────────────────────── */
    fill(0, groundTopY, width, height - groundTopY, GROUND);
    fill(0, groundTopY, width, unit * 0.2, GROUND_EDGE);
    const firstCol = Math.floor(worldX);
    const lastCol = Math.ceil(worldX + tilesVisible);
    for (let col = firstCol; col <= lastCol; col++) {
      const x = (col - worldX) * unit;
      fill(x, groundTopY + unit * 0.2, Math.max(1, unit / 12), height - groundTopY - unit * 0.2, GROUND_DARK);
    }

    /* ── Ground obstacles: pits, pipes, goombas ─────────────────────── */
    const firstPeriod = Math.floor(worldX / OBSTACLE_PERIOD) - 1;
    const lastPeriod = Math.ceil((worldX + tilesVisible) / OBSTACLE_PERIOD) + 1;
    for (let p = firstPeriod; p <= lastPeriod; p++) {
      const ob = obstacleAt(p);
      if (ob === null) continue;
      const screenX = (ob.at - worldX) * unit;

      if (ob.kind === "pit") {
        fill(screenX - unit * 0.75, groundTopY, unit * 1.5, height - groundTopY, VOID);
      } else if (ob.kind === "pipe") {
        const bodyH = ob.h * unit;
        fill(screenX - unit * 0.5, groundTopY - bodyH, unit, bodyH, PIPE);
        fill(screenX - unit * 0.5, groundTopY - bodyH, unit * 0.18, bodyH, PIPE_DARK);
        fill(screenX - unit * 0.62, groundTopY - bodyH - unit * 0.35, unit * 1.24, unit * 0.4, PIPE);
        fill(screenX - unit * 0.62, groundTopY - bodyH - unit * 0.35, unit * 0.18, unit * 0.4, PIPE_DARK);
      } else {
        const waddle = Math.floor(clock * 6 + p * 3) % 2 === 0;
        blit(screenX, groundTopY, waddle ? GOOMBA_A : GOOMBA_B, GOOMBA_PALETTE, unit / 15);
      }
    }

    /* ── Floating blocks ─────────────────────────────────────────────── */
    const firstBlockP = Math.floor(worldX / BLOCK_PERIOD) - 1;
    const lastBlockP = Math.ceil((worldX + tilesVisible) / BLOCK_PERIOD) + 1;
    for (let p = firstBlockP; p <= lastBlockP; p++) {
      const b = blockAt(p);
      if (b === null) continue;
      const screenX = (b.at - worldX) * unit;
      const y = groundTopY - b.row * unit;
      const size = unit * 0.85;
      if (b.brick) {
        fill(screenX - size / 2, y - size / 2, size, size, BRICK);
        fill(screenX - size / 2, y - size * 0.05, size, size * 0.1, BRICK_DARK);
        fill(screenX - size * 0.05, y - size / 2, size * 0.1, size * 0.45, BRICK_DARK);
        fill(screenX - size / 2, y - size / 2, size * 0.45, size * 0.1, BRICK_DARK);
      } else {
        blit(screenX, y + size / 2, QBLOCK, QBLOCK_PALETTE, size / 16);
      }
    }

    /* ── Mario ────────────────────────────────────────────────────────── */
    const marioWorld = worldX + MARIO_X;
    let jumpPix = 0;
    for (let p = Math.floor(marioWorld / OBSTACLE_PERIOD) - 1; p <= Math.floor(marioWorld / OBSTACLE_PERIOD) + 1; p++) {
      const ob = obstacleAt(p);
      if (ob === null) continue;
      const dx = marioWorld - ob.at;
      if (Math.abs(dx) < JUMP_WINDOW / 2) {
        const t = dx / (JUMP_WINDOW / 2);
        jumpPix = Math.max(jumpPix, Math.cos((t * Math.PI) / 2) * JUMP_HEIGHT * unit);
      }
    }

    // A hop is a rhythm of its own, independent of any obstacle — this is
    // Mario bouncing under a block he wants, not clearing something in his
    // path, so it runs on the chapter's own clock rather than world position.
    const hopPix =
      behaviour === "hop" ? Math.max(0, Math.sin((chapterT / HOP_PERIOD) * Math.PI)) * JUMP_HEIGHT * unit * 0.85 : 0;
    const totalJump = Math.max(jumpPix, hopPix);

    const cx = MARIO_X * unit;
    const bob = totalJump > 0 ? 0 : Math.abs(Math.sin(clock * 10)) * unit * 0.04;
    const footY = groundTopY - totalJump - bob;
    const running = behaviour === "run" || behaviour === "reverse";
    const frame =
      totalJump > 0 || !running
        ? MARIO_STAND
        : Math.floor(clock * 9) % 2 === 0
          ? MARIO_RUN_A
          : MARIO_RUN_B;
    blit(cx, footY, frame, MARIO_PALETTE, unit / 12, facing < 0);
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

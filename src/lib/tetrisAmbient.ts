import type { AmbientTuning } from "./ambient";
import type { Palette } from "./themes";

/**
 * Falling blocks, played by the classic three-term heuristic — aggregate
 * height, holes, bumpiness — scored once per spawn across every rotation and
 * column, then dropped straight down at whichever the heuristic liked best.
 * No line-by-line lookahead, no held piece: just enough to keep a stack tidy
 * and clear rows fairly often, forever.
 */
export function startTetrisAmbient(
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
  let clock = 0;

  const VOID = "#08080f";
  const WELL_BG = "#0e0e1c";
  const GRID_LINE = "#16162a";
  const STAR = "#22223a";
  const FLASH = "#ffffff";

  type PieceKey = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
  const PIECES: Record<PieceKey, { size: number; cells: [number, number][]; color: string }> = {
    I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], color: "#42d4f5" },
    O: { size: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], color: "#f5c542" },
    T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]], color: "#c542f5" },
    S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], color: "#3ddc84" },
    Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], color: "#f5455c" },
    J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]], color: "#4287f5" },
    L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]], color: "#f5a742" },
  };
  const KEYS = Object.keys(PIECES) as PieceKey[];

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

  /** Cells rotated 90° clockwise `times` within their own `size`x`size` box. */
  function rotate(cells: [number, number][], size: number, times: number): [number, number][] {
    let out = cells;
    for (let t = 0; t < times; t++) {
      out = out.map(([x, y]) => [size - 1 - y, x] as [number, number]);
    }
    return out;
  }

  const COLS = 10;
  const TARGET_ROWS = 20;

  let rows = 0;
  let cell = 0;
  let grid: (string | null)[][] = [];
  let pieceCount = 0;

  interface Falling {
    key: PieceKey;
    color: string;
    cells: [number, number][]; // absolute board columns, relative row offsets from `y`
    x: number;
    y: number; // topmost row index the piece's own row-0 sits at (may be negative)
  }
  let current: Falling | null = null;

  let fallAcc = 0;
  let clearing: number[] = [];
  let clearAcc = 0;
  let toppedAcc = 0;
  let topped = false;

  function collides(cellsAbs: [number, number][]): boolean {
    for (const [gx, gy] of cellsAbs) {
      if (gx < 0 || gx >= COLS || gy >= rows) return true;
      if (gy >= 0 && grid[gy][gx] !== null) return true;
    }
    return false;
  }

  function absCells(cells: [number, number][], x: number, y: number): [number, number][] {
    return cells.map(([cx, cy]) => [x + cx, y + cy] as [number, number]);
  }

  /** How good a landed placement is — lower is better. */
  function scoreLanding(testGrid: (string | null)[][]): number {
    const colHeights = new Array(COLS).fill(0);
    let holes = 0;
    for (let c = 0; c < COLS; c++) {
      let seenBlock = false;
      for (let r = 0; r < rows; r++) {
        if (testGrid[r][c] !== null) {
          if (!seenBlock) colHeights[c] = rows - r;
          seenBlock = true;
        } else if (seenBlock) {
          holes++;
        }
      }
    }
    const aggregate = colHeights.reduce((a, b) => a + b, 0);
    let bumpiness = 0;
    for (let c = 0; c < COLS - 1; c++) bumpiness += Math.abs(colHeights[c] - colHeights[c + 1]);
    return aggregate * 0.5 + holes * 3 + bumpiness * 0.3;
  }

  function dropLanding(cells: [number, number][], x: number): { y: number; cellsAbs: [number, number][] } | null {
    let y = -4;
    if (collides(absCells(cells, x, y))) return null; // spawn column already blocked
    while (!collides(absCells(cells, x, y + 1))) y++;
    return { y, cellsAbs: absCells(cells, x, y) };
  }

  function spawnPiece(): void {
    pieceCount++;
    const key = KEYS[Math.floor(hash(pieceCount * 17.3) * KEYS.length) % KEYS.length];
    const piece = PIECES[key];

    let best: { rot: number; x: number; score: number } | null = null;
    for (let rot = 0; rot < 4; rot++) {
      const cells = rotate(piece.cells, piece.size, rot);
      const maxX = piece.size - 1;
      for (let x = -1; x <= COLS - 1; x++) {
        // Only x positions that keep every cell on the board are worth trying.
        if (cells.some(([cx]) => x + cx < 0 || x + cx >= COLS)) continue;
        const landing = dropLanding(cells, x);
        if (landing === null) continue;
        const test = grid.map((row) => row.slice());
        for (const [gx, gy] of landing.cellsAbs) if (gy >= 0) test[gy][gx] = piece.color;
        const jitter = hash(pieceCount * 3.7 + rot * 11.1 + x * 5.3) * 0.6;
        const score = scoreLanding(test) + jitter;
        if (best === null || score < best.score) best = { rot, x, score };
        void maxX;
      }
    }

    const chosen = best ?? { rot: 0, x: Math.floor(COLS / 2) - 1, score: 0 };
    const cells = rotate(piece.cells, piece.size, chosen.rot);
    const spawnY = -Math.max(...cells.map(([, cy]) => cy)) - 1;
    current = { key, color: piece.color, cells, x: chosen.x, y: spawnY };
    if (collides(absCells(cells, chosen.x, spawnY + 1))) {
      // No room even at spawn — the well is full.
      topped = true;
      toppedAcc = 0;
    }
  }

  function resetWell(newRows: number): void {
    rows = newRows;
    grid = Array.from({ length: rows }, () => Array<string | null>(COLS).fill(null));
    current = null;
    clearing = [];
    topped = false;
    fallAcc = 0;
    spawnPiece();
  }

  function lockCurrent(): void {
    if (current === null) return;
    for (const [cx, cy] of absCells(current.cells, current.x, current.y)) {
      if (cy >= 0) grid[cy][cx] = current.color;
    }
    current = null;

    const full: number[] = [];
    for (let r = 0; r < rows; r++) if (grid[r].every((v) => v !== null)) full.push(r);
    if (full.length > 0) {
      clearing = full;
      clearAcc = 0;
    } else {
      spawnPiece();
    }
  }

  function draw(now: number): void {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;

    resize();

    const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    const motion = Math.max(0, tuning().motion);
    clock += dt * motion;

    const newCell = Math.max(6, Math.floor(height / TARGET_ROWS));
    const newRows = Math.max(10, Math.floor(height / newCell));
    if (newRows !== rows) {
      cell = newCell;
      resetWell(newRows);
    }
    const wellW = COLS * cell;
    const wellH = rows * cell;
    const ox = (width - wellW) / 2;
    const oy = (height - wellH) / 2;

    fill(0, 0, width, height, VOID);
    for (let i = 0; i < 30; i++) {
      const sx = hash(i * 19.3) * width;
      const sy = hash(i * 11.9 + 3) * height;
      if (sx > ox - cell && sx < ox + wellW + cell) continue;
      fill(sx, sy, 1.5, 1.5, STAR);
    }
    fill(ox, oy, wellW, wellH, WELL_BG);

    if (topped) {
      toppedAcc += dt * motion;
      if (toppedAcc > 1) resetWell(rows);
    } else if (clearing.length > 0) {
      clearAcc += dt * motion;
      if (clearAcc > 0.22) {
        const set = new Set(clearing);
        const kept = grid.filter((_, r) => !set.has(r));
        const blank = () => Array<string | null>(COLS).fill(null);
        grid = [...Array.from({ length: clearing.length }, blank), ...kept];
        clearing = [];
        spawnPiece();
      }
    } else if (current !== null) {
      const level = Math.min(10, Math.floor(pieceCount / 18));
      const fallInterval = Math.max(0.09, 0.46 - level * 0.035);
      fallAcc += dt * motion;
      while (fallAcc >= fallInterval) {
        fallAcc -= fallInterval;
        const next = absCells(current.cells, current.x, current.y + 1);
        if (collides(next)) {
          lockCurrent();
          break;
        }
        current.y++;
      }
    }

    // Locked cells, with a light bevel so the stack reads as blocks, not a grid.
    for (let r = 0; r < rows; r++) {
      const isClearing = clearing.includes(r);
      for (let c = 0; c < COLS; c++) {
        const color = grid[r][c];
        if (color === null) continue;
        const cx = ox + c * cell;
        const cy = oy + r * cell;
        if (isClearing && Math.floor(clearAcc * 20) % 2 === 0) {
          fill(cx + 1, cy + 1, cell - 2, cell - 2, FLASH);
        } else {
          fill(cx + 1, cy + 1, cell - 2, cell - 2, color);
          fill(cx + 1, cy + 1, cell - 2, cell * 0.22, "rgba(255,255,255,0.28)");
        }
      }
    }
    for (let c = 1; c < COLS; c++) fill(ox + c * cell, oy, 1, wellH, GRID_LINE);

    if (current !== null) {
      for (const [gx, gy] of absCells(current.cells, current.x, current.y)) {
        if (gy < 0) continue;
        const cx = ox + gx * cell;
        const cy = oy + gy * cell;
        fill(cx + 1, cy + 1, cell - 2, cell - 2, current.color);
        fill(cx + 1, cy + 1, cell - 2, cell * 0.22, "rgba(255,255,255,0.32)");
      }
    }
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

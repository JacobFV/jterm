import type { AmbientTuning } from "./ambient";
import type { Palette } from "./themes";

/**
 * Snake, actually playing itself: a greedy pathfinder with a little noise in
 * its scoring so it does not look like a solver, eating an endless sequence
 * of apples until it traps itself and starts over.
 */
export function startSnakeAmbient(
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

  const BOARD_A = "#122018";
  const BOARD_B = "#0e1a13";
  const SNAKE_A = "#4ade80";
  const SNAKE_B = "#34b869";
  const HEAD = "#a8f5c4";
  const EYE = "#0a1210";
  const FOOD = "#ff5d5d";
  const FOOD_HI = "#ff9a9a";

  const TARGET_ROWS = 17;
  const MOVE_INTERVAL = 0.13; // seconds per step at motion = 1
  const DEAD_PAUSE = 1.1;

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

  let cols = 0;
  let rows = 0;
  let cell = 0;
  let segments: [number, number][] = [];
  let dir: [number, number] = [1, 0];
  let food: [number, number] = [0, 0];
  let moveAcc = 0;
  let dead = false;
  let deadAcc = 0;
  let attempt = 0;
  let stepCount = 0;

  function occupied(x: number, y: number, excludeTail: boolean): boolean {
    for (let i = excludeTail ? 1 : 0; i < segments.length; i++) {
      if (segments[i][0] === x && segments[i][1] === y) return true;
    }
    return false;
  }

  function placeFood(): void {
    const total = cols * rows;
    for (let tries = 0; tries < total; tries++) {
      const seed = attempt * 9973 + stepCount * 131 + tries * 7919;
      const fx = Math.floor(hash(seed) * cols);
      const fy = Math.floor(hash(seed + 0.5) * rows);
      if (!occupied(fx, fy, false)) {
        food = [fx, fy];
        return;
      }
    }
    // Board is full — nowhere left to put an apple, so the run is over.
    dead = true;
  }

  function respawn(): void {
    attempt++;
    dead = false;
    deadAcc = 0;
    stepCount = 0;
    const y = Math.floor(rows / 2);
    const x = Math.max(2, Math.floor(cols / 3));
    segments = [
      [x - 2, y],
      [x - 1, y],
      [x, y],
    ];
    dir = [1, 0];
    placeFood();
  }

  function step(): void {
    const head = segments[segments.length - 1];
    const candidates: [number, number][] = (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]
    ).filter(([dx, dy]) => !(dx === -dir[0] && dy === -dir[1]));

    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (const [dx, dy] of candidates) {
      const nx = head[0] + dx;
      const ny = head[1] + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (occupied(nx, ny, true)) continue;
      const dist = Math.abs(nx - food[0]) + Math.abs(ny - food[1]);
      const jitter = hash(stepCount * 13.7 + dx * 3.1 + dy * 7.3 + attempt * 997) * 2.2;
      const score = dist + jitter;
      if (score < bestScore) {
        bestScore = score;
        best = [dx, dy];
      }
    }

    if (best === null) {
      dead = true;
      return;
    }
    dir = best;
    const nx = head[0] + dir[0];
    const ny = head[1] + dir[1];
    segments.push([nx, ny]);
    if (nx === food[0] && ny === food[1]) {
      placeFood();
    } else {
      segments.shift();
    }
    stepCount++;
  }

  function draw(now: number): void {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;

    resize();

    const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    const motion = Math.max(0, tuning().motion);
    clock += dt;

    const newCell = Math.max(4, Math.floor(height / TARGET_ROWS));
    const newCols = Math.max(6, Math.floor(width / newCell));
    const newRows = Math.max(6, Math.floor(height / newCell));
    if (newCols !== cols || newRows !== rows) {
      cols = newCols;
      rows = newRows;
      cell = newCell;
      respawn();
    }
    const ox = (width - cols * cell) / 2;
    const oy = (height - rows * cell) / 2;

    if (dead) {
      deadAcc += dt * motion;
      if (deadAcc >= DEAD_PAUSE) respawn();
    } else {
      moveAcc += dt * motion;
      while (moveAcc >= MOVE_INTERVAL) {
        moveAcc -= MOVE_INTERVAL;
        step();
        if (dead) break;
      }
    }

    // Board, checkered.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        fill(ox + x * cell, oy + y * cell, cell + 0.5, cell + 0.5, (x + y) % 2 === 0 ? BOARD_A : BOARD_B);
      }
    }

    // Food, with a small blinking highlight.
    const fx = ox + food[0] * cell;
    const fy = oy + food[1] * cell;
    fill(fx + cell * 0.12, fy + cell * 0.12, cell * 0.76, cell * 0.76, FOOD);
    fill(fx + cell * 0.22, fy + cell * 0.18, cell * 0.22, cell * 0.18, FOOD_HI);

    // Snake, tail to head, flashing red an instant before a reset.
    const flashing = dead && Math.floor(deadAcc * 8) % 2 === 0;
    for (let i = 0; i < segments.length; i++) {
      const [sx, sy] = segments[i];
      const isHead = i === segments.length - 1;
      const color = flashing ? FOOD : isHead ? HEAD : i % 2 === 0 ? SNAKE_A : SNAKE_B;
      fill(ox + sx * cell + 0.5, oy + sy * cell + 0.5, cell - 1, cell - 1, color);
      if (isHead && !flashing) {
        const ex = dir[0] > 0 ? 0.62 : dir[0] < 0 ? 0.18 : 0.4;
        const ey = dir[1] > 0 ? 0.62 : dir[1] < 0 ? 0.18 : 0.32;
        fill(ox + sx * cell + cell * ex, oy + sy * cell + cell * ey, cell * 0.16, cell * 0.16, EYE);
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

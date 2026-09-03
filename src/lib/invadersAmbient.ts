import type { AmbientTuning } from "./ambient";
import type { Palette } from "./themes";

/**
 * A wave of invaders marches, drops, reverses, and marches back — the classic
 * step-and-descend gait, speeding up as the formation thins — while a cannon
 * on the ground tracks whoever is lowest and fires. Clearing a wave (or, more
 * often, the formation finally reaching the ground) just starts the next one;
 * there is no game over here, only more waves.
 */
export function startInvadersAmbient(
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

  const SPACE = "#050506";
  const STAR = "#2a2a34";
  const CANNON = "#33ff66";
  const BULLET = "#e8ffe8";
  const ENEMY_BULLET = "#ff8a94";
  const FLASH = "#ffe199";
  const ROW_COLORS = ["#ff7ee2", "#ff7ee2", "#5ef2e0", "#5ef2e0", "#ffd166"];

  const COLS = 8;
  const ROWS = 5;
  const H_SPACING = 1.7; // tiles between alien columns
  const V_SPACING = 1.4; // tiles between alien rows
  const STEP_SIZE = 0.42; // tiles the formation shifts per march step
  const MAX_DESCENTS = 7;

  /** 11x8, two legs-open/legs-closed frames — a stand-in for the arcade sprite, not a trace of it. */
  const INVADER_A = [
    "..A.....A..",
    "...A...A...",
    "..AAAAAAA..",
    ".AA.AAA.AA.",
    "AAAAAAAAAAA",
    "A.AAAAAAA.A",
    "A.A.....A.A",
    "...AA.AA...",
  ];
  const INVADER_B = [
    "..A.....A..",
    "A..A...A..A",
    "A.AAAAAAA.A",
    "AAA.AAA.AAA",
    "AAAAAAAAAAA",
    "..AAAAAAA..",
    "..A.....A..",
    ".A.......A.",
  ];
  const CANNON_SHAPE = ["...A...", "..AAA..", ".AAAAA.", "AAAAAAA"];

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

  function blit(x: number, y: number, rows: string[], color: string, cell: number): void {
    ctx!.fillStyle = color;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] === ".") continue;
        ctx!.fillRect(Math.round(x + c * cell), Math.round(y + r * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  }

  let alive: boolean[][] = [];
  let wave = 0;
  let formationX = 0;
  let dir = 1;
  let descents = 0;
  let stepAcc = 0;
  let marchFrame = 0;
  let cannonX = COLS / 2;
  let fireAcc = 0;
  let enemyFireAcc = 0;
  let bullets: { x: number; y: number }[] = [];
  let enemyBullets: { x: number; y: number }[] = [];
  const killed = new Map<string, number>(); // "row,col" -> clock at death

  function newWave(): void {
    wave++;
    alive = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));
    formationX = 0;
    dir = 1;
    descents = 0;
    bullets = [];
    enemyBullets = [];
    killed.clear();
  }
  newWave();

  function aliveCount(): number {
    let n = 0;
    for (const row of alive) for (const a of row) if (a) n++;
    return n;
  }

  function lowestTarget(): { row: number; col: number } | null {
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        if (alive[r][c]) return { row: r, col: c };
      }
    }
    return null;
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

    const unit = height / 13;
    const boardTop = unit * 1.5;
    // Tile-space coordinates throughout: `boardLeft` is the pixel origin for
    // tile 0, and `formationX` (tiles) is clamped to `maxX` below so the
    // *rightmost* column's own sprite width never marches past the margin —
    // not just its top-left corner, which is what let the formation run off
    // the pane entirely before this was fixed.
    const boardLeft = unit * 0.8;
    const formationSpan = (COLS - 1) * H_SPACING + 1.1;
    const maxX = Math.max(0, width / unit - 1.6 - formationSpan);

    // March: speed scales with how few are left, like the arcade original.
    const remaining = Math.max(1, aliveCount());
    const stepInterval = 0.11 + 0.75 * (remaining / (ROWS * COLS));
    stepAcc += dt * motion;
    if (stepAcc >= stepInterval && remaining > 0) {
      stepAcc = 0;
      marchFrame = 1 - marchFrame;
      const next = formationX + dir * STEP_SIZE;
      if (next < 0 || next > maxX) {
        dir = -dir;
        descents++;
        if (descents >= MAX_DESCENTS) newWave();
      } else {
        formationX = next;
      }
    }

    fill(0, 0, width, height, SPACE);
    // A scatter of static stars, deterministic per pane size.
    for (let i = 0; i < 40; i++) {
      const sx = hash(i * 13.1) * width;
      const sy = hash(i * 7.7 + 1) * (height - unit * 2);
      fill(sx, sy, 1.5, 1.5, STAR);
    }

    const alienCell = (H_SPACING * unit) / 11.5;
    const descentY = boardTop + descents * V_SPACING * unit;
    if (remaining === 0) newWave();

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ax = boardLeft + (formationX + c * H_SPACING) * unit;
        const ay = descentY + r * V_SPACING * unit;
        const key = `${r},${c}`;
        if (alive[r][c]) {
          blit(ax, ay, marchFrame === 0 ? INVADER_A : INVADER_B, ROW_COLORS[r % ROW_COLORS.length], alienCell);
        } else {
          const deathT = killed.get(key);
          if (deathT !== undefined && clock - deathT < 0.18) {
            fill(ax + alienCell * 2, ay + alienCell * 1, alienCell * 7, alienCell * 6, FLASH);
          }
        }
      }
    }

    // The cannon tracks whoever is lowest and fires when roughly under them.
    const target = lowestTarget();
    if (target) {
      const targetX = formationX + target.col * H_SPACING;
      cannonX += Math.max(-1, Math.min(1, targetX - cannonX)) * dt * motion * 3.2;
    }
    const cannonPx = boardLeft + cannonX * unit;
    const cannonY = height - unit * 1.4;
    blit(cannonPx - unit * 0.35, cannonY, CANNON_SHAPE, CANNON, unit / 7);

    fireAcc += dt * motion;
    if (target && fireAcc > 0.55 + hash(wave * 3.1 + descents) * 0.4) {
      const targetX = formationX + target.col * H_SPACING;
      if (Math.abs(targetX - cannonX) < 0.35) {
        fireAcc = 0;
        bullets.push({ x: cannonPx, y: cannonY });
      }
    }

    enemyFireAcc += dt * motion;
    if (enemyFireAcc > 1.1 && remaining > 0) {
      enemyFireAcc = 0;
      if (hash(clock * 31 + wave * 11) < 0.6) {
        const r = Math.floor(hash(clock * 17) * ROWS);
        const c = Math.floor(hash(clock * 23) * COLS);
        if (alive[r]?.[c]) {
          enemyBullets.push({
            x: boardLeft + (formationX + c * H_SPACING) * unit + alienCell * 5.5,
            y: descentY + r * V_SPACING * unit + alienCell * 8,
          });
        }
      }
    }

    const BULLET_SPEED = 9 * unit;
    bullets = bullets.filter((b) => {
      b.y -= BULLET_SPEED * dt * motion;
      if (b.y < 0) return false;
      const relX = (b.x - boardLeft) / unit - formationX;
      const relY = (b.y - descentY) / unit;
      const c = Math.round(relX / H_SPACING);
      const r = Math.round(relY / V_SPACING);
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS && alive[r]?.[c] && Math.abs(relX - c * H_SPACING) < 0.9) {
        alive[r][c] = false;
        killed.set(`${r},${c}`, clock);
        return false;
      }
      fill(b.x - 1, b.y, 2, unit * 0.35, BULLET);
      return true;
    });

    enemyBullets = enemyBullets.filter((b) => {
      b.y += BULLET_SPEED * 0.55 * dt * motion;
      if (b.y > height) return false;
      fill(b.x - 1, b.y, 2, unit * 0.3, ENEMY_BULLET);
      return true;
    });
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

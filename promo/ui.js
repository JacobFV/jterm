// A stateless drawing of jterm: every function here turns a description of a
// moment into HTML, so a frame depends on nothing but the time it is for.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = (p) => { p = clamp(p); return p * p * (3 - 2 * p); };
const eout = (p) => 1 - Math.pow(1 - clamp(p), 3);
const eback = (p) => { p = clamp(p); const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
const seg = (b, a, z) => clamp((b - a) / (z - a));
const rnd = hash;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const px = (n) => Math.round(n * 100) / 100 + "px";

// ── themes: a terminal palette each, the chrome computed from it ──────────
const T = (bg, fg, cursor, r, g, y, b, m, c, d, accent, amb) => ({ bg, fg, cursor, r, g, y, b, m, c, d, accent: accent || cursor, amb });
const THEMES = {
  dark: T("#000000", "#ededed", "#f2cd6b", "#e35a5a", "#8bbf7a", "#e0b155", "#6c9bd1", "#b98cc7", "#6fb3ae", "#545454"),
  light: T("#ffffff", "#1a1a1c", "#a8760a", "#c0392b", "#3f7a35", "#96690c", "#2f5fa8", "#7d4a94", "#2b7772", "#8b8b90"),
  gruvbox: T("#1d2021", "#ebdbb2", "#fabd2f", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#928374"),
  dracula: T("#282a36", "#f8f8f2", "#ff79c6", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#6272a4", "#bd93f9"),
  nord: T("#2e3440", "#d8dee9", "#88c0d0", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#616e88"),
  monokai: T("#272822", "#f8f8f2", "#f8f8f0", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#75715e", "#a6e22e"),
  tokyo: T("#1a1b26", "#c0caf5", "#7aa2f7", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#565f89"),
  mocha: T("#1e1e2e", "#cdd6f4", "#f5e0dc", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#6c7086", "#cba6f7"),
  latte: T("#eff1f5", "#4c4f69", "#dc8a78", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#8c8fa1", "#8839ef"),
  solarized: T("#002b36", "#93a1a1", "#b58900", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#586e75"),
  sollight: T("#fdf6e3", "#586e75", "#b58900", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#93a1a1"),
  rosepine: T("#191724", "#e0def4", "#ebbcba", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#6e6a86", "#c4a7e7"),
  everforest: T("#2d353b", "#d3c6aa", "#a7c080", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#7a8478"),
  kanagawa: T("#1f1f28", "#dcd7ba", "#c8c093", "#c34043", "#76946a", "#c0a36e", "#7e9cd8", "#957fb8", "#6a9589", "#727169", "#7e9cd8"),
  synthwave: T("#262335", "#f8f8f2", "#ff7edb", "#fe4450", "#72f1b8", "#fede5d", "#2ee2fa", "#ff7edb", "#03edf9", "#6d77b3"),
  phosphor: T("#0a1109", "#33ff33", "#7fff7f", "#2fdd2f", "#33ff33", "#66ff66", "#1fbb1f", "#55ee55", "#44ff88", "#1f8a1f", "#33ff33"),
  amber: T("#140d02", "#ffb000", "#ffcc44", "#ff8c1a", "#ffb000", "#ffc233", "#cc8800", "#ffa033", "#ffd166", "#8a6016", "#ffb000"),
  blueprint: T("#10365c", "#e8f2ff", "#ffffff", "#ffb3b3", "#b9e6c8", "#ffe9a8", "#a8cbff", "#dcc3ff", "#b2ecf2", "#5f8fc0", "#a8cbff"),
  parchment: T("#f4ecd8", "#3b3227", "#a0522d", "#a03e2f", "#55702f", "#97701a", "#3a5f8a", "#7a4a78", "#2f6f6a", "#8f8370"),
  hotdog: T("#ff0000", "#ffff00", "#ffffff", "#ffffff", "#ffff00", "#ffff88", "#000000", "#ffffff", "#ffff00", "#ffb0b0", "#ffff00"),
  mandelbrot: T("#08060f", "#ded6ff", "#a78bfa", "#ff6b8a", "#7ee0b8", "#f0c674", "#7aa2ff", "#c792ea", "#74d7ec", "#6a5fa2", "#c792ea", "mandel"),
  aurora: T("#04101a", "#d8ecf5", "#7ef0c8", "#ff8a8a", "#7ef0c8", "#ffe08a", "#7fc4ff", "#c6a6ff", "#7fe8f0", "#4b7690", null, "aurora"),
  rain: T("#020604", "#9dffb0", "#b8ffc8", "#4bff9b", "#35f56f", "#86ff9e", "#22c463", "#62ff8f", "#4dffc2", "#2d8c50", "#35f56f", "rain"),
  warp: T("#01030a", "#dce6ff", "#9ec5ff", "#ff7b8f", "#86e6b4", "#ffd98f", "#7fb0ff", "#c39cff", "#86dcf5", "#55659e", null, "warp"),
  lava: T("#12060a", "#ffe3d1", "#ff8c42", "#ff5c5c", "#d2c04a", "#ffb03a", "#ff7a45", "#ff6f9c", "#ffcf6b", "#9b4d48", null, "lava"),
  lorenz: T("#05060f", "#dfe4f5", "#8fb8ff", "#ff8095", "#8ee0b0", "#f0cf92", "#8fb8ff", "#c3a2f5", "#8ad9ea", "#56608b", null, "lorenz"),
};
const THEME_NAMES = { dark: "Dark", light: "Light", gruvbox: "Gruvbox", dracula: "Dracula", nord: "Nord", monokai: "Monokai", tokyo: "Tokyo Night", mocha: "Catppuccin Mocha", latte: "Catppuccin Latte", solarized: "Solarized Dark", sollight: "Solarized Light", rosepine: "Rosé Pine", everforest: "Everforest", kanagawa: "Kanagawa", synthwave: "Synthwave", phosphor: "Green Phosphor", amber: "Amber CRT", blueprint: "Blueprint", parchment: "Parchment", hotdog: "Hotdog Stand", mandelbrot: "Mandelbrot", aurora: "Aurora", rain: "Digital Rain", warp: "Starfield", lava: "Lava Lamp", lorenz: "Lorenz" };

const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const cssc = (c, a = 1) => (a >= 1 ? `rgb(${c})` : `rgba(${c},${a})`);
const varCache = {};
function themeVars(id) {
  if (varCache[id]) return varCache[id];
  const th = THEMES[id] || THEMES.dark, bg = rgbOf(th.bg), fg = rgbOf(th.fg), ac = rgbOf(th.accent);
  const a = th.amb ? 0.58 : 1, s = (t) => cssc(mixc(bg, fg, t), th.amb ? 0.72 : 1);
  const lum = (ac[0] * 0.3 + ac[1] * 0.59 + ac[2] * 0.11) / 255;
  return (varCache[id] =
    `--ground:${th.amb ? "transparent" : th.bg};--bg0:${cssc(bg, a)};--bg1:${s(0.03)};--bg2:${s(0.06)};--bg3:${s(0.1)};` +
    `--b1:${cssc(mixc(bg, fg, 0.11))};--b2:${cssc(mixc(bg, fg, 0.2))};--t1:${th.fg};--t2:${cssc(mixc(fg, bg, 0.3))};` +
    `--t3:${cssc(mixc(fg, bg, 0.54))};--t4:${cssc(mixc(fg, bg, 0.72))};--brand:${th.accent};--brandfg:${lum > 0.5 ? "#0b0900" : "#fff"};` +
    `--termbg:${cssc(bg, a)};--bg:${th.bg};--fg:${th.fg};--cursor:${th.cursor};--r:${th.r};--g:${th.g};--y:${th.y};--b:${th.b};--m:${th.m};--c:${th.c};--d:${th.d};`);
}

// ── icons (lucide's outlines) ─────────────────────────────────────────────
const ICONS = {
  term: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 11 2-2-2-2M11 13h4"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  right: '<path d="m9 18 6-6-6-6"/>', down: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  git: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>', plus: '<path d="M5 12h14M12 5v14"/>', minus: '<path d="M5 12h14"/>',
  square: '<rect x="4" y="4" width="16" height="16"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  spark: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',
  flask: '<path d="M10 2v7.5L4.7 19a2 2 0 0 0 1.8 3h11a2 2 0 0 0 1.8-3L14 9.5V2M8.5 2h7M7 16h10"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  issue: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1.5"/>',
  diff: '<path d="M12 3v14M5 10h14M5 21h14"/>',
  art: '<path d="M8.3 10a.7.7 0 0 1-.63-1.08L11.4 3a.7.7 0 0 1 1.2-.04L16.3 8.900a.7.7 0 0 1-.57 1.100Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.500" cy="17.500" r="3.500"/>',
  gh: '<path d="M15 22v-4a4.800 4.800 0 0 0-1-3.500c3 0 6-2 6-5.500.08-1.250-.27-2.480-1-3.500.28-1.150.28-2.350 0-3.500 0 0-1 0-3 1.500-2.640-.5-5.360-.5-8 0C6 2 5 2 5 2c-.3 1.150-.3 2.350 0 3.500A5.400 5.400 0 0 0 4 9c0 3.500 3 5.500 6 5.500-.39.49-.68 1.050-.85 1.650S8.930 17.380 9 18v4M9 18c-4.510 2-5-2-7-2"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.500 2H20v20H6.500a2.500 2.500 0 0 1 0-5H20"/>',
};
const ic = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24">${ICONS[n] || ICONS.term}</svg>`;
const GRIP = '<svg class="ic grip" viewBox="0 0 12 24" style="width:7px"><g fill="currentColor" stroke="none"><circle cx="3" cy="6" r="1.6"/><circle cx="9" cy="6" r="1.6"/><circle cx="3" cy="12" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="3" cy="18" r="1.6"/><circle cx="9" cy="18" r="1.6"/></g></svg>';

// ── layout trees: ['h'|'v', [ratios]?, ...children], a leaf is a pane id ──
function rects(tree, r, out = {}) {
  if (typeof tree === "string") { out[tree] = r; return out; }
  const [dir, ...rest] = tree;
  const hasRatios = Array.isArray(rest[0]) && typeof rest[0][0] === "number";
  const kids = hasRatios ? rest.slice(1) : rest, ratios = hasRatios ? rest[0] : kids.map(() => 1 / kids.length);
  let pos = 0;
  kids.forEach((k, i) => {
    const f = ratios[i];
    rects(k, dir === "h" ? { x: r.x + r.w * pos, y: r.y, w: r.w * f, h: r.h } : { x: r.x, y: r.y + r.h * pos, w: r.w, h: r.h * f }, out);
    pos += f;
  });
  return out;
}
/** Where a pane that did not exist a moment ago grows out of. */
function born(b, A) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const pa = Object.values(A).find((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h);
  if (!pa) return { ...b, o: 0 };
  if (b.x > pa.x + 2) return { x: pa.x + pa.w, y: b.y, w: 0, h: b.h };
  if (b.y > pa.y + 2) return { x: b.x, y: pa.y + pa.h, w: b.w, h: 0 };
  return { ...b, o: 0 };
}
function mixRects(A, B, p) {
  const out = {};
  for (const id in B) {
    const b = B[id], a = A[id] || born(b, A);
    out[id] = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p), o: lerp(a.o ?? 1, 1, p) };
  }
  return out;
}
/** The rects at beat `b` of a list of [beat, tree] keyframes, easing between. */
function layoutAt(b, keys, bounds, dur = 0.5, fn = eback) {
  let i = 0;
  while (i + 1 < keys.length && b >= keys[i + 1][0]) i++;
  const cur = rects(keys[i][1], bounds);
  if (i === 0) return cur;
  const p = (b - keys[i][0]) / dur;
  return p >= 1 ? cur : mixRects(rects(keys[i - 1][1], bounds), cur, fn(p));
}

// ── pane bodies ───────────────────────────────────────────────────────────
const LH = 17;
const parseCache = new Map();
function parse(line) {
  let c = parseCache.get(line);
  if (c) return c;
  c = [];
  let i = 0, m;
  const re = /«(\w+):([^»]*)»/g;
  while ((m = re.exec(line))) {
    if (m.index > i) c.push(["", line.slice(i, m.index)]);
    c.push([m[1], m[2]]);
    i = re.lastIndex;
  }
  if (i < line.length) c.push(["", line.slice(i)]);
  parseCache.set(line, c);
  return c;
}
function lineHtml(segs, n = 1e9) {
  let h = "";
  for (const [c, t] of segs) {
    if (n <= 0) break;
    const s = t.length > n ? t.slice(0, n) : t;
    n -= s.length;
    h += c ? `<i class="${c}">${esc(s)}</i>` : esc(s);
  }
  return h;
}
const linesOf = (p, t) => { const src = LIB[p.c] || p.c || []; return typeof src === "function" ? src(t + (p.dt || 0)) : src; };

function termBody(p, w, h, t) {
  const rows = Math.max(1, Math.floor((h - 8) / LH));
  let lines = linesOf(p, t);
  if (p.extra) lines = lines.concat(p.extra);
  let n = p.n == null ? 1e9 : Math.floor(p.n);
  const vis = [];
  for (const ln of lines) {
    if (n <= 0) break;
    const segs = parse(ln), len = segs.reduce((a, s) => a + s[1].length, 0);
    vis.push(lineHtml(segs, n));
    n -= len + 1;
  }
  if (!vis.length) vis.push("");
  if (p.cur !== false) vis[vis.length - 1] += `<b class="cur${p.blur ? " off" : ""}"${!p.blur && (t * 1.6) % 1 > 0.6 && p.blink ? ' style="opacity:.15"' : ""}></b>`;
  return `<div class="term">${vis.slice(-rows).map((l) => `<div>${l || " "}</div>`).join("")}</div>`;
}
function editBody(p, w, h, t) {
  const src = CODE[p.c] || [], rows = Math.floor((h - 32) / 19) + 1, top = Math.max(0, Math.floor(p.top || 0));
  let out = "";
  for (let i = top; i < Math.min(src.length, top + rows); i++)
    out += `<div class="${p.hl === i ? "hl" : ""}"><u>${i + 1}</u>${lineHtml(parse(src[i]))}</div>`;
  return `<div class="sub"><span>${esc(p.path || "~/jterm/" + p.title)}</span><b class="chip">Save</b></div><div class="ed" style="top:26px">${out}</div>`;
}
function mdBody() {
  const node = (x, y, w, label, hot) => `<rect x="${x}" y="${y}" width="${w}" height="26" rx="3" fill="${hot ? "var(--brand)" : "var(--bg3)"}" stroke="var(--b2)"/><text x="${x + w / 2}" y="${y + 17}" text-anchor="middle" font-size="11" fill="${hot ? "var(--brandfg)" : "var(--t1)"}" font-family="var(--sans)">${label}</text>`;
  const arrow = (x1, x2, y) => `<path d="M${x1} ${y}H${x2 - 5}" stroke="var(--t3)" fill="none"/><path d="M${x2} ${y}l-6 -3v6z" fill="var(--t3)"/>`;
  return `<div class="md"><h1>jterm</h1><p>A tabbed terminal with tmux-style splits, where a pane can also be a notepad, a browser, or a viewer.</p>
  <h2>The half-typed command</h2><p>Mirrored from your keystrokes, saved on a short timer, restored on launch — <code>never with a newline</code>.</p>
  <svg width="430" height="50" style="margin:8px 0">${node(0, 10, 86, "keystroke")}${arrow(86, 112, 23)}${node(112, 10, 66, "draft")}${arrow(178, 204, 23)}${node(204, 10, 62, "disk", 1)}${arrow(266, 292, 23)}${node(292, 10, 62, "crash")}${arrow(354, 380, 23)}${node(380, 10, 50, "back")}</svg>
  <table><tr><th>Survives</th><th>How</th></tr><tr><td>Input</td><td>typed back at the prompt</td></tr><tr><td>Screen</td><td>as the emulator last drew it</td></tr><tr><td>Process</td><td>a tmux session per terminal</td></tr><tr><td>Agent</td><td><code>--resume</code> into that conversation</td></tr></table></div>`;
}
function stlBody(p, w, h, t) {
  const nu = 22, nv = 11, R = 1, r = 0.42, ay = t * 1.1 + (p.dt || 0), ax = 0.55 + 0.3 * Math.sin(t * 0.7);
  const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const rot = ([x, y, z]) => { const x1 = x * cy + z * sy, z1 = -x * sy + z * cy; return [x1, y * cx - z1 * sx, y * sx + z1 * cx]; };
  const V = [];
  for (let i = 0; i < nu; i++) { V.push([]); for (let j = 0; j < nv; j++) { const u = (i / nu) * 6.2832, v = (j / nv) * 6.2832; V[i].push(rot([(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)])); } }
  const faces = [], S = Math.min(w, h - 26) * 0.3, ox = w / 2, oy = (h - 26) / 2 + 26;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = V[i][j], b = V[(i + 1) % nu][j], c = V[(i + 1) % nu][(j + 1) % nv], d = V[i][(j + 1) % nv];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    if (nz > 0) continue;
    const lit = clamp(-(nx * 0.35 + ny * 0.55 + nz * 0.76));
    faces.push([(a[2] + b[2] + c[2] + d[2]) / 4, [a, b, c, d].map((q) => `${(ox + q[0] * S).toFixed(1)},${(oy + q[1] * S).toFixed(1)}`).join(" "), 22 + lit * 62]);
  }
  faces.sort((a, b) => b[0] - a[0]);
  return `<div class="sub"><span>~/models/${esc(p.title)}</span><span style="flex:none">${nu * nv * 2} triangles · drag to rotate</span></div><svg width="${w}" height="${h}" style="position:absolute;left:0;top:0">${faces.map((f) => `<polygon points="${f[1]}" fill="hsl(0 0% ${f[2].toFixed(0)}%)" stroke="hsl(0 0% ${(f[2] * 0.82).toFixed(0)}%)" stroke-width=".5"/>`).join("")}</svg>`;
}
function imgBody(p, w, h) {
  return `<div class="sub"><span>~/renders/${esc(p.title)}</span><span style="flex:none">1920×1080</span><b class="chip" style="margin-left:0">1:1</b></div><svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" style="position:absolute;left:0;top:26px;width:100%;height:calc(100% - 26px)">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1140"/><stop offset=".55" stop-color="#c2417a"/><stop offset="1" stop-color="#ffb35c"/></linearGradient></defs>
  <rect width="320" height="180" fill="url(#sky)"/><circle cx="200" cy="112" r="44" fill="#ffe08a"/>
  <path d="M0 140 60 92 96 122 150 70 214 132 262 100 320 138V180H0Z" fill="#2a1446"/><path d="M0 160 70 128 130 152 200 120 270 150 320 136V180H0Z" fill="#120824"/>
  ${Array.from({ length: 9 }, (_, i) => `<rect x="0" y="${118 + i * 7}" width="320" height="${1 + i * 0.5}" fill="#c2417a" opacity=".0"/>`).join("")}</svg>`;
}
function webBody(p, w, h, t) {
  const bars = Array.from({ length: 14 }, (_, i) => `<rect x="${i * 22}" y="${80 - (20 + 55 * Math.abs(Math.sin(i * 0.9 + t * 2)))}" width="14" height="${20 + 55 * Math.abs(Math.sin(i * 0.9 + t * 2))}" fill="${i % 3 ? "#151515" : "#d9a520"}"/>`).join("");
  return `<div class="sub" style="background:var(--bg1)">${ic("globe")}<span style="color:var(--t1)">${esc(p.url || "localhost:5173/dashboard")}</span></div>
  <div class="web" style="top:26px"><div style="height:38px;display:flex;align-items:center;gap:18px;padding:0 18px;border-bottom:1px solid #ddd;font-weight:700"><b style="font:800 17px var(--disp)">relay<i style="color:#d9a520">.</i></b><i style="color:#777">Panes</i><i style="color:#777">Peers</i><i style="color:#777">Logs</i></div>
  <div style="padding:16px 18px"><div style="font:800 26px/1.1 var(--disp);letter-spacing:-.02em">${(1284 + Math.floor(t * 31)).toLocaleString("en-US")} <i style="font:500 12px var(--sans);color:#777">keystrokes mirrored / min</i></div>
  <svg width="310" height="84" style="margin-top:12px">${bars}</svg>
  <div style="display:flex;gap:10px;margin-top:10px">${["3 windows", "11 panes", "2 peers"].map((s) => `<i style="border:1px solid #ccc;padding:5px 10px;border-radius:3px;background:#fff">${s}</i>`).join("")}</div></div></div>`;
}
function vncBody(p, w, h, t) {
  return `<div style="position:absolute;inset:0;background:linear-gradient(135deg,#27408b,#7b3fa0 55%,#e8746a)">
  <div style="position:absolute;left:0;right:0;top:0;height:16px;background:rgba(255,255,255,.22);font:600 9px var(--sans);color:#fff;padding:2px 8px">  Finder  File  Edit  View<i style="float:right">Wed 9:41</i></div>
  <div style="position:absolute;left:8%;top:16%;width:52%;height:52%;background:#fafafa;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.4);overflow:hidden"><div style="height:16px;background:#e4e4e4;display:flex;gap:4px;align-items:center;padding-left:6px"><i style="width:7px;height:7px;border-radius:50%;background:#ff5f57"></i><i style="width:7px;height:7px;border-radius:50%;background:#febc2e"></i><i style="width:7px;height:7px;border-radius:50%;background:#28c840"></i></div>
  ${Array.from({ length: 6 }, (_, i) => `<div style="height:6px;margin:8px 10px 0;width:${40 + rnd(i) * 50}%;background:#ccc;border-radius:3px"></div>`).join("")}</div>
  <div style="position:absolute;left:46%;top:38%;width:44%;height:44%;background:#1d1f27;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);font:8px/11px var(--mono);color:#9ece6a;padding:18px 8px 0">$ xcodebuild -scheme jterm<br><i style="color:#ccc">▸ Compiling window_chrome.rs</i><br><i style="color:#ccc">▸ Linking jterm</i><br>** BUILD SUCCEEDED **</div>
  <div style="position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:flex;gap:5px;padding:4px 7px;background:rgba(255,255,255,.25);border-radius:8px">${["#f2cd6b", "#4c8dff", "#28c840", "#ff5f57", "#bbb"].map((c) => `<i style="width:15px;height:15px;border-radius:4px;background:${c}"></i>`).join("")}</div></div>`;
}
function plotBody(p, w, h, t) {
  const pts = Array.from({ length: 60 }, (_, i) => `${i * 5},${(100 - 86 * Math.exp(-i / 16) - 6 * rnd(i + 2) + 0).toFixed(1)}`).join(" ");
  const pts2 = Array.from({ length: 60 }, (_, i) => `${i * 5},${(100 - 70 * Math.exp(-i / 22) - 8 * rnd(i + 40)).toFixed(1)}`).join(" ");
  const head = [P + "python plot.py «d:# matplotlib, sixel backend»"].map((l) => `<div>${lineHtml(parse(l))}</div>`).join("");
  return `<div class="term">${head}<svg viewBox="-24 -6 330 124" style="display:block;width:${Math.min(w - 20, 420)}px;height:${Math.min(h - 70, 170)}px;background:#fff;margin:4px 0">
  <path d="M0 0V104H300" stroke="#222" fill="none"/>${[26, 52, 78].map((y) => `<path d="M0 ${y}H300" stroke="#ddd"/>`).join("")}
  <polyline points="${pts}" fill="none" stroke="#d9480f" stroke-width="2"/><polyline points="${pts2}" fill="none" stroke="#1c7ed6" stroke-width="2"/>
  <text x="150" y="116" font-size="8" text-anchor="middle" fill="#222">step</text><text x="210" y="60" font-size="8" fill="#d9480f">eval acc</text><text x="210" y="72" font-size="8" fill="#1c7ed6">train acc</text></svg><div>${lineHtml(parse(P))}<b class="cur"></b></div></div>`;
}

// ── the GitHub panes, the diff, and what an agent draws ───────────────────
const pill = (state) => { const [c, icn, label] = { open: ["g", "issue", "Open"], merged: ["m", "merge", "Merged"], closed: ["m", "check", "Closed"], propen: ["g", "pr", "Open"] }[state]; return `<i class="pill" style="color:var(--${c});background:color-mix(in srgb,var(--${c}) 18%,transparent)">${ic(icn)}${label}</i>`; };
const avatar = (name, hue) => `<i class="av" style="background:hsl(${hue} 55% 45%)">${name[0].toUpperCase()}</i>`;
const comment = (name, hue, when, html) => `<div class="ghc">${avatar(name, hue)}<div><div class="who"><b>${name}</b> ${when}</div>${html}</div></div>`;
function issueBody(p) {
  return `<div class="gh"><div class="ght">Pop-up forgets its size after a restart <i>#212</i></div>
  <div class="ghm">${pill(p.closed ? "closed" : "open")}<i><b>mara-k</b> opened this 2 days ago · 3 comments</i><i class="lab" style="--c:var(--r)">bug</i><i class="lab" style="--c:var(--b)">restore</i></div>
  ${comment("mara-k", 330, "2 days ago", "Resize a pop-up on the rail, quit, reopen. It comes back at <code>470×300</code> every time — the pane inside is restored, its box is not.")}
  ${comment("devon", 200, "yesterday", "Same on macOS. <code>snapshotRail</code> never writes <code>w</code>/<code>h</code>, so there is nothing to read back.")}
  ${comment("claude", 42, "just now", "On it — the snapshot drops the size and the decoder hard-codes it. Fix and a test coming as a PR.")}</div>`;
}
const CHECKS = [["types", "npx tsc -b", "14s"], ["test", "vitest · 413 passed", "31s"], ["build", "vite build", "22s"], ["cargo", "clippy · test", "1m 12s"]];
function prBody(p, w, h, t) {
  const done = p.checks ?? 4;
  const rows = CHECKS.map(([name, what, took], i) => `<div class="chk">${i < done ? `<i class="g">${ic("check")}</i>` : `<i class="y spin" style="transform:rotate(${Math.floor(t * 8) * 45}deg)">${ic("spark")}</i>`}<b>${name}</b><i>${what}</i><u>${i < done ? took : "running"}</u></div>`).join("");
  return `<div class="gh"><div class="ght">Remember a pop-up's size across restarts <i>#213</i></div>
  <div class="ghm">${pill(p.merged ? "merged" : "propen")}<i><b>claude</b> wants to merge 1 commit into <code>main</code> from <code>fix/popup-size</code></i></div>
  <div class="ghtabs"><b>Conversation</b><i>Checks <u>${done}/4</u></i><i>Files <u>2</u></i><span><i class="g">+9</i> <i class="r">−3</i></span></div>
  ${comment("claude", 42, "1 minute ago", "Fixes <b style='color:var(--b)'>#212</b>. The rail's snapshot now carries <code>w</code> and <code>h</code>; the decoder clamps what it reads and falls back per field.")}
  <div class="chks">${rows}</div>
  <div class="ghb">${p.merged ? `<div class="btn" style="background:var(--m);color:#fff">${ic("merge")}Merged into main</div>` : `<div class="btn${p.press ? " press" : ""}"${done < 4 ? ' style="opacity:.45"' : ""}>${ic("merge")}Squash and merge</div>`}<div class="btn ghost">Check out</div><div class="btn ghost">${ic("globe")}Open</div></div></div>`;
}
function diffBody(p, w, h, t) {
  const split = p.split ?? (w > 560 && rnd((p.dt || 0) + 3) < 0.5), n = p.n ?? 99;
  const num = (v) => `<u>${v || ""}</u>`, cls = { "+": "dp", "-": "dm", "@": "dh", " ": "" };
  const text = (k, s) => (k === "@" ? esc(s) : `<b>${k === " " ? " " : k === "-" ? "−" : "+"}</b>${esc(s)}`);
  let rows = [];
  if (!split) rows = DIFF.map(([k, a, b, s]) => `<div class="${cls[k]}">${k === "@" ? "" : num(a) + num(b)}${text(k, s)}</div>`);
  else {
    // Side by side: a run of removals sits across from the run of additions that replaced it.
    const cell = (r, side) => r ? `<span class="half ${cls[r[0]]}">${num(side ? r[2] : r[1])}${text(r[0], r[3])}</span>` : '<span class="half dx"></span>';
    for (let i = 0; i < DIFF.length;) {
      const r = DIFF[i];
      if (r[0] === "@") { rows.push(`<div class="dh">${esc(r[3])}</div>`); i++; continue; }
      if (r[0] === " ") { rows.push(`<div>${cell(r, 0)}${cell(r, 1)}</div>`); i++; continue; }
      const del = [], add = [];
      while (i < DIFF.length && DIFF[i][0] === "-") del.push(DIFF[i++]);
      while (i < DIFF.length && DIFF[i][0] === "+") add.push(DIFF[i++]);
      for (let j = 0; j < Math.max(del.length, add.length); j++) rows.push(`<div>${cell(del[j], 0)}${cell(add[j], 1)}</div>`);
    }
  }
  const seg = (label, on) => `<b class="chip${on ? " on" : ""}${p.press === label ? " press" : ""}" style="margin-left:0">${label}</b>`;
  return `<div class="sub">${ic("diff")}<span>${esc(p.what || "working tree")} · 1 file</span><i class="g" style="flex:none">+9</i><i class="r" style="flex:none">−3</i>${seg("Unified", !split)}${seg("Split", split)}</div>
  <div class="dfile">${ic("down")}<span>src/lib/rail.ts</span><i class="badge y">M</i></div><div class="df${split ? " sp" : ""}">${rows.slice(0, Math.max(0, Math.floor(n))).join("")}</div>`;
}
function artBody(p, w, h, t) {
  const g = p.n == null ? 0.8 + 0.2 * Math.sin(t * 2.2 + (p.dt || 0)) : eout(clamp(p.n));
  const win = (x, label, col, pw, ph, sub) => `<g transform="translate(${x} 0)"><rect width="200" height="124" rx="3" fill="var(--bg1)" stroke="var(--b2)"/><rect width="200" height="12" fill="var(--bg3)"/>
    <rect x="${14}" y="${112 - ph}" width="${pw}" height="${ph}" fill="color-mix(in srgb,var(--${col}) 22%,transparent)" stroke="var(--${col})" stroke-width="1.5"/>
    <text x="${14 + pw / 2}" y="${112 - ph / 2 + 4}" text-anchor="middle" font-size="10" fill="var(--${col})" font-family="var(--mono)">${sub}</text>
    <text x="0" y="142" font-size="11" fill="var(--t2)" font-family="var(--sans)">${label}</text></g>`;
  return `<div class="sub">${ic("art")}<span style="color:var(--t1)">${esc(p.title || "Pop-up geometry")}</span><i class="badge a" style="flex:none">HTML</i><b class="chip" style="margin-left:0">Source</b><b class="chip" style="margin-left:0">Save</b></div>
  <div class="art"><h1>Pop-up geometry, before and after</h1><p>You resized the pop-up to <code>640×380</code> and quit. This is what reopening does.</p>
  <svg viewBox="0 0 430 150" style="display:block;width:${Math.min(430, w - 36)}px;margin:10px 0 6px">${win(0, "before · resets", "r", 86, 54, "470×300")}${win(230, "after · as you left it", "g", lerp(86, 150, g), lerp(54, 84, g), g > 0.6 ? "640×380" : "…")}</svg>
  <div class="arow"><i class="g">${ic("check")}</i>size survives a restart<u>rail.test.ts</u></div><div class="arow"><i class="g">${ic("check")}</i>a hostile size is clamped<u>snapshot.test.ts</u></div><div class="arow"><i class="g">${ic("check")}</i>old snapshots still load<u>snapshot.test.ts</u></div></div>`;
}
const BODIES = { pr: prBody, issue: issueBody, diff: diffBody, art: artBody, term: termBody, edit: editBody, md: mdBody, stl: stlBody, img: imgBody, web: webBody, vnc: vncBody, plot: plotBody };
const KIND_ICON = { pr: "pr", issue: "issue", diff: "diff", art: "art", term: "term", edit: "file", md: "book", stl: "box", img: "image", web: "globe", vnc: "monitor", plot: "term" };

function paneHtml(p, r, o = {}) {
  if (r.w < 3 || r.h < 3) return "";
  const w = Math.round(r.x + r.w) - Math.round(r.x), h = Math.round(r.y + r.h) - Math.round(r.y);
  const body = h > 26 && !o.min ? (BODIES[p.k || "term"] || termBody)(p, w, h - 22, o.t) : "";
  const card = p.card ? `<div class="card"><div>${p.card.title}</div><div style="color:var(--t1);margin-top:4px">${p.card.cmd}</div><div class="btns"><div class="btn${p.card.press === 0 ? " press" : ""}" style="margin:0;height:auto">${p.card.a}</div><div class="btn ghost" style="margin:0;height:auto">${p.card.b}</div></div></div>` : "";
  const tools = o.pop ? `${ic("minus")}${ic("square")}` : "";
  return `<div class="pane${o.focus ? " f" : ""}${o.pop ? " pop" : ""}${o.grab ? " grab" : ""}" style="left:${Math.round(r.x)}px;top:${Math.round(r.y)}px;width:${w}px;height:${o.min ? 23 : h}px;${o.z ? `z-index:${o.z};` : ""}${(r.o ?? 1) < 1 || o.dim ? `opacity:${(r.o ?? 1) * (o.dim || 1)};` : ""}${p.theme ? themeVars(p.theme) : ""}${o.style || ""}">` +
    `<div class="ph">${GRIP}${ic(p.icon || KIND_ICON[p.k || "term"], "kind")}<span>${esc(p.title || "")}</span>${tools}${ic("x")}</div><div class="pb">${body}${card}</div></div>`;
}

// ── sidebar ───────────────────────────────────────────────────────────────
const TOOLS = { files: ["folder", "Files"], search: ["search", "Search"], git: ["git", "Git"], agent: ["bot", "Agent"], github: ["gh", "GitHub"] };
function sideHtml(sb, t) {
  const head = (title, extra = "") => `<div class="sh"><div class="sw${sb.menu ? " on" : ""}">${ic(TOOLS[sb.tool][0])}${ic("down")}</div><span>${title}</span><div class="hb">${extra}</div></div>`;
  let body = "";
  if (sb.tool === "files") {
    const open = sb.open || {}, vis = {};
    body = head("~/jterm", ic("plus") + ic("search"));
    for (const [depth, kind, name, key, parent] of TREE) {
      const show = !parent || (open[parent] && vis[parent]);
      if (key) vis[key] = show;
      if (!show) continue;
      const isOpen = key && open[key];
      body += `<div class="row${sb.sel === name ? " sel" : ""}${sb.hot === name ? " hot" : ""}" style="padding-left:${8 + depth * 13}px">${kind === "d" ? ic(isOpen ? "down" : "right") + ic("folder") : '<i style="width:12px"></i>' + ic("file")}<i${kind === "d" ? ' class="dir"' : ""}>${name}</i></div>`;
    }
  } else if (sb.tool === "search") {
    const q = sb.q || "";
    body = head("search ~/jterm") + `<div class="field focus">${ic("search")}<i>${esc(q)}</i><b class="cur" style="width:1px;margin-left:-5px"></b></div>`;
    let left = q.length >= 3 ? sb.n ?? 99 : 0;
    if (q.length >= 3) body += `<div class="sec">${Math.min(9, Math.floor(left))} matches in 5 files</div>`;
    for (const [file, hits] of HITS) {
      if (left <= 0) break;
      body += `<div class="row" style="padding-left:8px">${ic("down")}${ic("file")}<i style="color:var(--t1)">${file.split("/").pop()}</i><i class="badge d">${hits.length}</i></div>`;
      for (const [ln, a, m, z] of hits) {
        if (left-- <= 0) break;
        body += `<div class="hit${sb.hot === file + ln ? " row hot" : ""}"><u>${ln}</u>${esc(a)}<em>${m.slice(0, Math.max(3, q.length))}</em>${esc(m.slice(Math.max(3, q.length)) + z)}</div>`;
      }
    }
  } else if (sb.tool === "git") {
    const st = sb.staged || 0, done = sb.done;
    const fileRow = ([s, f], staged) => `<div class="row${sb.hot === f ? " hot" : ""}" style="padding-left:10px">${ic("file")}<i>${f.split("/").pop()}</i><i class="badge ${s === "M" ? "y" : s === "A" ? "g" : "r"}">${staged ? "−" : "+"} ${s}</i></div>`;
    body = head(`main <i class="g">↑${done ? 1 : 0}</i> <i class="d">origin/main</i>`, ic("down") + ic("plus"));
    if (!done) {
      body += `<div class="sec">Staged · ${st}</div>` + GIT_FILES.slice(0, st).map((f) => fileRow(f, 1)).join("");
      body += `<div class="sec">Changes · ${GIT_FILES.length - st}</div>` + GIT_FILES.slice(st).map((f) => fileRow(f, 0)).join("");
    } else body += `<div class="sec">Working tree clean</div>`;
    body += `<div class="field${sb.msg ? " focus" : ""}" style="white-space:normal;line-height:1.35">${sb.msg ? `<i>${esc(sb.msg)}<b class="cur" style="width:1px"></b></i>` : '<i class="d">Message</i>'}</div><div class="btn${sb.press ? " press" : ""}">${ic("check")}Commit</div>`;
    body += `<div class="sec">History</div>` + (done ? [["a91c3e7", "Restore unsubmitted input after a crash", 1]] : []).concat(GIT_LOG).slice(0, 7).map(([h, s, hot]) => `<div class="row${hot ? " hot" : ""}" style="padding-left:10px"><i class="y">${h}</i><i style="overflow:hidden;text-overflow:ellipsis">${esc(s)}</i></div>`).join("");
  } else if (sb.tool === "github") {
    const row = (icn, col, [num, title], hot) => `<div class="row${hot ? " hot" : ""}" style="padding-left:10px"><i class="${col}" style="display:flex">${ic(icn)}</i><i class="d">#${num}</i><i style="overflow:hidden;text-overflow:ellipsis;font-family:var(--sans)">${esc(title)}</i></div>`;
    const prs = GH_PRS.slice(sb.prs ?? 0);
    body = head("JacobFV/jterm", ic("plus")) + `<div class="sec">Pull requests · ${prs.length}</div>` + prs.map((r) => row("pr", "g", r, sb.hot === r[0])).join("") +
      `<div class="sec">Issues · ${GH_ISSUES.length}</div>` + GH_ISSUES.map((r) => row("issue", "g", r, sb.hot === r[0])).join("");
  } else {
    body = head("claude · ~/jterm", ic("plus")) + `<div style="position:absolute;inset:28px 0 0 0;background:var(--termbg)"><div style="transform:scale(.86);transform-origin:0 0;width:116%;height:116%;position:relative">${termBody({ c: AGENT, n: sb.n }, 270, 760, t)}</div></div>`;
  }
  return `<div class="side" style="width:${Math.round(sb.w)}px"><div>${body}</div></div>`;
}

// ── a whole window ────────────────────────────────────────────────────────
function menuHtml(m) {
  return `<div class="menu" style="left:${Math.round(m.x)}px;top:${Math.round(m.y)}px;${m.w ? `width:${m.w}px;` : ""}${m.o != null ? `opacity:${m.o};` : ""}">` +
    m.items.map((it, i) => it === "-" ? '<div class="sep"></div>' : it[0] === "#" ? `<div class="head">${it.slice(1)}</div>` :
      `<div class="${m.hi === i ? "hi" : ""}">${Array.isArray(it) ? it[0] : it}${Array.isArray(it) && it[1] ? `<kbd>${it[1]}</kbd>` : ""}</div>`).join("") + "</div>";
}
/** The workspace's box inside a window, for scenes that need to aim at a pane. */
const wsBox = (s) => ({ x: 0, y: 0, w: (s.W || 1280) - (s.side ? Math.round(s.side.w) : 0), h: (s.H || 720) - 34 });
const wsOrigin = (s) => ({ x: s.side ? Math.round(s.side.w) : 0, y: 34 });

function winHtml(s, t) {
  const W = s.W || 1280, H = s.H || 720, sw = s.side ? Math.round(s.side.w) : 0;
  let h = `<div class="jt${s.framed ? " framed" : ""}" style="left:${px(s.x || 0)};top:${px(s.y || 0)};width:${W}px;height:${H}px;${s.scale ? `transform:scale(${s.scale});` : ""}${s.o != null ? `opacity:${s.o};` : ""}${themeVars(s.theme || "dark")}${s.style || ""}">`;
  h += '<div class="tabs">' + (s.tabs || [{ title: "jterm" }]).map((tab, i) =>
    `<div class="tab${i === (s.tab || 0) ? " on" : ""}${tab.gone ? " gone" : ""}"${tab.w != null ? ` style="width:${tab.w}px;padding:0 ${Math.min(10, tab.w / 4)}px"` : ""}>${ic(tab.icon || "term")}<span>${esc(tab.title)}</span>${ic("x", "x")}</div>`).join("") +
    `<div class="tabplus">${ic("plus")}</div><div class="wc"><div>${ic("minus")}</div><div>${ic("square")}</div><div>${ic("x")}</div></div></div>`;
  if (sw > 1) h += sideHtml(s.side, t);
  h += `<div class="ws" style="left:${sw}px;top:34px;width:${W - sw}px;height:${H - 34}px">`;
  for (const id in s.rects) {
    const p = s.panes[id];
    if (p) h += paneHtml(p, s.rects[id], { t, focus: s.focus === id, grab: s.grab === id, dim: s.grab === id ? 0.45 : 0, z: s.rects[id].z });
  }
  if (s.drop) h += `<div class="drop" style="left:${Math.round(s.drop.x)}px;top:${Math.round(s.drop.y)}px;width:${Math.round(s.drop.w)}px;height:${Math.round(s.drop.h)}px"></div>`;
  for (const pop of s.popups || []) h += paneHtml(pop.p, pop, { t, pop: 1, focus: pop.focus, min: pop.min, z: 50 });
  h += "</div>";
  for (const m of s.menus || []) h += menuHtml(m);
  if (s.ghost) h += `<div class="ghost" style="left:${Math.round(s.ghost.x)}px;top:${Math.round(s.ghost.y)}px;${s.ghost.tab ? "height:30px;font:12px var(--sans);" : ""}">${s.ghost.tab ? "" : GRIP}${ic(s.ghost.icon || "term")}${esc(s.ghost.title)}</div>`;
  return h + "</div>";
}

// ── living themes: what is drawn behind the panes ─────────────────────────
const AMB = {
  rain(g, t) {
    g.fillStyle = "#020604"; g.fillRect(0, 0, 640, 360);
    g.font = "bold 11px monospace";
    for (let c = 0; c < 72; c++) {
      const sp = 0.25 + rnd(c) * 0.5, head = ((t * sp + rnd(c + 50)) % 1.3) * 420;
      for (let k = 0; k < 22; k++) {
        const y = head - k * 11;
        if (y < 0 || y > 370) continue;
        g.fillStyle = k === 0 ? "#d8ffe0" : `rgba(53,245,111,${(1 - k / 22) * 0.85})`;
        g.fillText(String.fromCharCode(0x30a0 + Math.floor(rnd(c * 31 + k + Math.floor(t * 9 + k * 0.3)) * 90)), c * 9, y);
      }
    }
  },
  warp(g, t) {
    g.fillStyle = "#01030a"; g.fillRect(0, 0, 640, 360);
    for (let i = 0; i < 420; i++) {
      const a = rnd(i) * 6.2832, z = 1 - ((t * (0.25 + rnd(i + 9) * 0.5) + rnd(i + 3)) % 1), r0 = 14 + rnd(i + 5) * 60;
      const r1 = r0 / z, r2 = r0 / (z + 0.035);
      g.strokeStyle = `rgba(${170 + rnd(i + 1) * 80},${200 + rnd(i + 2) * 55},255,${clamp(1.2 - z)})`;
      g.lineWidth = clamp(1.6 - z * 1.4, 0.4, 2);
      g.beginPath(); g.moveTo(320 + Math.cos(a) * r2, 180 + Math.sin(a) * r2); g.lineTo(320 + Math.cos(a) * r1, 180 + Math.sin(a) * r1); g.stroke();
    }
  },
  aurora(g, t) {
    g.fillStyle = "#04101a"; g.fillRect(0, 0, 640, 360);
    g.globalCompositeOperation = "lighter";
    const cols = ["126,240,200", "127,196,255", "198,166,255"];
    for (let k = 0; k < 3; k++) for (let x = 0; x < 640; x += 4) {
      const y = 120 + k * 30 + 46 * Math.sin(x * 0.011 + t * (0.9 + k * 0.4) + k * 2) + 20 * Math.sin(x * 0.031 - t * 1.3 + k), hgt = 120 + 70 * Math.sin(x * 0.02 + t * 0.7 + k * 4);
      const gr = g.createLinearGradient(0, y - hgt, 0, y);
      gr.addColorStop(0, `rgba(${cols[k]},0)`); gr.addColorStop(1, `rgba(${cols[k]},.34)`);
      g.fillStyle = gr; g.fillRect(x, y - hgt, 4, hgt);
    }
    g.globalCompositeOperation = "source-over";
  },
  lava(g, t) {
    const w = 160, h = 90, img = g.createImageData(w, h), d = img.data, balls = [];
    for (let i = 0; i < 7; i++) balls.push([80 + 62 * Math.sin(t * (0.5 + i * 0.13) + i * 2.1), 45 + 38 * Math.sin(t * (0.7 + i * 0.09) + i * 1.3), 11 + 5 * rnd(i)]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (const [bx, by, br] of balls) s += (br * br) / ((x - bx) ** 2 + (y - by) ** 2 + 1);
      const v = clamp((s - 0.7) * 2.5), i = (y * w + x) * 4;
      d[i] = 18 + 237 * v; d[i + 1] = 6 + 120 * v * v; d[i + 2] = 10 + 50 * (1 - v) * v; d[i + 3] = 255;
    }
    AMB._small(g, img, w, h);
  },
  mandel(g, t) {
    const w = 213, h = 120, img = g.createImageData(w, h), d = img.data;
    const zoom = Math.exp(-(1.2 + 3.2 * (0.5 - 0.5 * Math.cos(t * 0.9)))), cx0 = -0.7436, cy0 = 0.1318;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const cr = cx0 + ((x - w / 2) / h) * 3 * zoom, ci = cy0 + ((y - h / 2) / h) * 3 * zoom;
      let zr = 0, zi = 0, n = 0;
      while (n < 90 && zr * zr + zi * zi < 16) { const q = zr * zr - zi * zi + cr; zi = 2 * zr * zi + ci; zr = q; n++; }
      const i = (y * w + x) * 4, v = n >= 90 ? 0 : n + 1 - Math.log2(Math.log(zr * zr + zi * zi) / 2);
      d[i] = n >= 90 ? 8 : 60 + 110 * (0.5 + 0.5 * Math.sin(v * 0.21 + t)); d[i + 1] = n >= 90 ? 6 : 30 + 70 * (0.5 + 0.5 * Math.sin(v * 0.17 + 2)); d[i + 2] = n >= 90 ? 15 : 110 + 140 * (0.5 + 0.5 * Math.sin(v * 0.13 + 4)); d[i + 3] = 255;
    }
    AMB._small(g, img, w, h);
  },
  lorenz(g, t) {
    g.fillStyle = "#05060f"; g.fillRect(0, 0, 640, 360);
    let x = 0.1, y = 0, z = 0;
    const a = t * 0.6, ca = Math.cos(a), sa = Math.sin(a), n = 2600, head = Math.floor((t * 520) % n);
    g.lineWidth = 1;
    let px0 = 0, py0 = 0;
    for (let i = 0; i < n; i++) {
      const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - (8 / 3) * z;
      x += dx * 0.006; y += dy * 0.006; z += dz * 0.006;
      const X = 320 + (x * ca - y * sa) * 8.5, Y = 370 - z * 7.2;
      if (i > 0) {
        const age = (head - i + n) % n;
        g.strokeStyle = `rgba(143,184,255,${0.12 + 0.85 * Math.pow(1 - age / n, 6)})`;
        g.beginPath(); g.moveTo(px0, py0); g.lineTo(X, Y); g.stroke();
      }
      px0 = X; py0 = Y;
    }
  },
  _small(g, img, w, h) {
    if (!AMB._c) AMB._c = document.createElement("canvas");
    AMB._c.width = w; AMB._c.height = h;
    AMB._c.getContext("2d").putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(AMB._c, 0, 0, 640, 360);
  },
};

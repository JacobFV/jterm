// The film. `renderAt(t)` draws the frame for time `t` and nothing else decides
// what is on screen, so frames can be rendered in any order, in parallel.
//
// 150 BPM: a beat is 0.4 s, 24 frames at 60 fps. Everything is written in beats.

const BEAT = 0.4, TOTAL = 58.4;
const ICON = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 1024 1024"><rect x="24" y="24" width="976" height="976" rx="179" fill="#050505" stroke="#2c2c2c" stroke-width="8"/><rect x="557" y="178" width="150" height="172" rx="12" fill="#f2cd6b"/><path d="M632 434V622Q632 782 502 782 366 782 396 727" fill="none" stroke="#f2cd6b" stroke-width="128" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const frac = (x) => x - Math.floor(x);

function track(b, keys) {
  if (b <= keys[0][0]) return { x: keys[0][1], y: keys[0][2] };
  for (let i = 0; i < keys.length - 1; i++) {
    const [b0, x0, y0] = keys[i], [b1, x1, y1] = keys[i + 1];
    if (b < b1) {
      const p = ease((b - b0) / (b1 - b0));
      return { x: lerp(x0, x1, p), y: lerp(y0, y1, p) - Math.sin(p * Math.PI) * Math.min(26, Math.hypot(x1 - x0, y1 - y0) * 0.07) };
    }
  }
  const k = keys[keys.length - 1];
  return { x: k[1], y: k[2] };
}
/** Beats since the latest of `clicks`, for the ring a click leaves. */
const since = (b, clicks) => { let s = 99; for (const c of clicks) if (b >= c) s = Math.min(s, b - c); return s; };

// ── what a pane can hold ──────────────────────────────────────────────────
const CAT = {
  cargo: { title: "cargo build --release", icon: "cpu", c: "cargo", rate: 260 },
  vitest: { title: "npm test", icon: "flask", c: "vitest", rate: 300 },
  htop: { title: "htop", icon: "cpu", c: "htop", cur: false },
  gitlog: { title: "git log --graph", icon: "git", c: "gitlog", rate: 520 },
  logs: { title: "tail -f access.log", icon: "server", c: "logs", cur: false },
  python: { title: "python", c: "python", rate: 260 },
  claude: { title: "claude", icon: "spark", c: "claude", rate: 220 },
  codex: { title: "codex", icon: "bot", c: "codex", rate: 220 },
  ssh: { title: "deploy@prod-7: ~", icon: "server", c: "ssh", rate: 320 },
  docker: { title: "docker ps", icon: "box", c: "docker", rate: 400 },
  k8s: { title: "kubectl get pods -w", icon: "server", c: "k8s", rate: 400 },
  ls: { title: "j@studio: ~/jterm", c: "ls", rate: 500 },
  fetch: { title: "fastfetch", c: "fetch", rate: 500 },
  psql: { title: "psql jterm", icon: "db", c: "psql", rate: 400 },
  pytest: { title: "pytest -q", icon: "flask", c: "pytest", rate: 360 },
  nvim: { title: "nvim src/demo.rs", icon: "file", c: "nvim", cur: false },
  nvidia: { title: "nvidia-smi", icon: "cpu", c: "nvidia", rate: 600 },
  vite: { title: "npm run dev", icon: "globe", c: "vite", rate: 300, cur: false },
  diff: { title: "git diff", icon: "git", c: "diff", rate: 400 },
  curl: { title: "curl | jq", c: "curl", rate: 400 },
  tmux: { title: "tmux ls", c: "tmux", rate: 400 },
  make: { title: "make -j20 firmware", icon: "cpu", c: "make", rate: 300 },
  train: { title: "python train.py", icon: "flask", c: "train", cur: false },
  rsync: { title: "rsync → prod-7", icon: "server", c: "rsyncrun", cur: false },
  rs: { k: "edit", title: "draft.rs", c: "rs", path: "~/jterm/src-tauri/src/draft.rs" },
  tsx: { k: "edit", title: "Workspace.tsx", c: "tsx", path: "~/jterm/src/components/shell/Workspace.tsx" },
  py: { k: "edit", title: "model.py", c: "py", path: "~/lab/model.py" },
  md: { k: "md", title: "README.md" },
  stl: { k: "stl", title: "gear.stl" },
  img: { k: "img", title: "shot_0042.png" },
  web: { k: "web", title: "localhost:5173" },
  vnc: { k: "vnc", title: "vnc://studio-mac" },
  plot: { k: "plot", title: "python plot.py", icon: "image" },
  prv: { k: "pr", title: "#213 Remember a pop-up's size" },
  issue: { k: "issue", title: "#212 Pop-up forgets its size" },
  diffv: { k: "diff", title: "Changes · rail.ts" },
  art: { k: "art", title: "Pop-up geometry" },
};
/** A pane from the catalogue, `lt` beats into streaming its output. */
const mk = (key, lt = 99, extra) => Object.assign({}, CAT[key], CAT[key].rate ? { n: Math.max(0, lt) * CAT[key].rate } : null, extra);
const TABS = [{ title: "jterm", icon: "spark" }, { title: "api · prod-7", icon: "server" }, { title: "notes", icon: "book" }];

// ── overlay type ──────────────────────────────────────────────────────────
function tag(F, text, b0, o = {}) {
  const p = eback(seg(F.b, b0, b0 + 0.4)), pulse = 1 + 0.035 * Math.exp(-5 * frac(F.b));
  const x = o.x ?? 34, y = o.y ?? 642;
  F.over += `<div class="tag${o.dark ? " dark" : ""}" style="left:${x}px;top:${y}px;transform-origin:0 100%;transform:translateX(${(1 - p) * -700}px) rotate(${o.rot ?? -2}deg) scale(${pulse * (o.s || 1)})">${text}</div>`;
}
function note(F, text, b0, x, y, b1 = 1e9) {
  if (F.b < b0 || F.b >= b1) return;
  const p = eout(seg(F.b, b0, b0 + 0.3));
  F.over += `<div class="note" style="left:${x}px;top:${y}px;opacity:${p};transform:translateY(${(1 - p) * 10}px)">${text}</div>`;
}
function keys(F, labels, b0, x = 640, y = 600) {
  const lt = F.b - b0;
  if (lt < 0 || lt > 0.8) return;
  const p = eback(seg(lt, 0, 0.18)), out = 1 - seg(lt, 0.55, 0.8);
  F.over += `<div class="key" style="left:${x}px;top:${y}px;transform:translate(-50%,${lt < 0.2 ? 5 : 0}px) scale(${p});opacity:${out}">${labels.map((l) => `<b>${l}</b>`).join("")}</div>`;
}
function tape(text, y, rot, t, dir = 1, k = false) {
  const unit = `${text}  ✦  `, shift = ((t * 150 * dir) % 600 + 600) % 600;
  return `<div class="tape${k ? " k" : ""}" style="top:${y}px;transform:rotate(${rot}deg)"><span style="display:inline-block;transform:translateX(${-shift}px)">${unit.repeat(14)}</span></div>`;
}
function lockup(scale = 1, y = 330, extra = "") {
  return `<div style="position:absolute;left:640px;top:${y}px;transform:translate(-50%,-50%) scale(${scale});display:flex;align-items:center;gap:30px">${ICON(200)}<div style="font:700 176px/1 var(--mono);color:#fff;letter-spacing:-.08em;margin-top:-18px">jterm</div><div style="background:var(--gold);color:#0b0900;font:800 118px/1 var(--disp);padding:6px 22px 12px;transform:rotate(-5deg);letter-spacing:-.05em;margin-left:14px">1.0</div>${extra}</div>`;
}
function word(text, size, o = {}) {
  return `<div class="big${o.mono ? " monoB" : ""}${o.stroke ? " stroke" : ""}" style="left:${o.x ?? 640}px;top:${o.y ?? 360}px;font-size:${size}px;transform:translate(-50%,-50%) rotate(${o.rot || 0}deg) scale(${o.s || 1});${o.color ? `color:${o.color};` : ""}${o.o != null ? `opacity:${o.o};` : ""}">${text}</div>`;
}

// ── the mash-up: a different situation for every index ────────────────────
const LAYS = [
  ["h", "0", "1"],
  ["h", [0.6, 0.4], "0", ["v", "1", "2"]],
  ["v", [0.6, 0.4], ["h", "0", "1"], "2"],
  ["h", ["v", "0", "1"], ["v", "2", "3"]],
  ["h", [0.3, 0.4, 0.3], "0", "1", "2"],
  ["h", [0.5, 0.5], "0", ["v", "1", ["h", "2", "3"]]],
  ["v", ["h", "0", "1", "2"], ["h", [0.35, 0.65], "3", "4"]],
  ["h", [0.42, 0.58], ["v", "0", "1", "2"], "3"],
  ["v", [0.34, 0.66], "0", ["h", "1", "2"]],
  ["h", [0.64, 0.36], ["v", [0.62, 0.38], "0", ["h", "1", "2"]], ["v", "3", "4"]],
];
const SLOTS = [2, 3, 3, 4, 3, 4, 5, 4, 3, 5];
const TERMS = ["cargo", "vitest", "htop", "gitlog", "logs", "python", "claude", "codex", "ssh", "docker", "k8s", "ls", "fetch", "psql", "pytest", "nvim", "nvidia", "vite", "diff", "curl", "tmux", "make", "train", "rsync"];
const VIEWS = ["rs", "tsx", "py", "md", "stl", "img", "web", "plot", "vnc", "prv", "issue", "diffv", "art"];
const MASH_THEMES = ["dark", "dark", "tokyo", "gruvbox", "dracula", "dark", "synthwave", "nord", "mocha", "phosphor", "dark", "rosepine", "latte", "kanagawa", "amber", "monokai", "everforest", "blueprint", "solarized"];
const LIVING = ["aurora", "warp", "rain", "lorenz", "lava", "mandelbrot"];

/** Which pane the point is over, and which of its edges is nearest. */
function hitEdge(R, x, y) {
  for (const id in R) {
    const r = R[id];
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    const d = [["l", (x - r.x) / r.w], ["r", (r.x + r.w - x) / r.w], ["t", (y - r.y) / r.h], ["b", (r.y + r.h - y) / r.h]];
    return { id, e: d.reduce((a, c) => (c[1] < a[1] ? c : a))[0] };
  }
  return null;
}
const half = (r, e) => e === "l" ? { x: r.x, y: r.y, w: r.w / 2, h: r.h } : e === "r" ? { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h } : e === "t" ? { x: r.x, y: r.y, w: r.w, h: r.h / 2 } : { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };
const edgePt = (r, e) => e === "l" ? { x: r.x + r.w * 0.13, y: r.y + r.h * 0.5 } : e === "r" ? { x: r.x + r.w * 0.87, y: r.y + r.h * 0.5 } : e === "t" ? { x: r.x + r.w * 0.5, y: r.y + r.h * 0.14 } : { x: r.x + r.w * 0.5, y: r.y + r.h * 0.85 };
const mashCursor = (b) => ({ x: 640 + 500 * Math.sin(b * 0.83 + 1), y: 390 + 260 * Math.sin(b * 1.31 + 2) });

/**
 * Shot `i`, `lt` beats in. `o.pool` front-loads what the panes hold, so a bar
 * can be *about* something; `o.W`/`o.H` make a smaller window of it.
 */
function mashShot(i, lt, b, o = {}) {
  const r = (k) => rnd(i * 17.3 + k * 3.1);
  const li = Math.floor(r(1) * LAYS.length), n = SLOTS[li];
  const living = o.living ?? r(2) < 0.16;
  const s = { W: o.W, H: o.H, theme: o.theme || (living ? LIVING[Math.floor(r(3) * LIVING.length)] : MASH_THEMES[Math.floor(r(3) * MASH_THEMES.length)]), panes: {} };
  const pool = (o.pool || []).concat(r(4) < 0.5 ? VIEWS : [], TERMS, VIEWS);
  const used = new Set(), start = Math.floor(r(5) * 7);
  for (let j = 0; j < n; j++) {
    let q = j < (o.pool ? Math.min(n, o.pool.length) : 0) ? (start + j) % o.pool.length : (o.pool ? o.pool.length : 0) + Math.floor(r(10 + j) * (pool.length - (o.pool ? o.pool.length : 0)));
    while (used.has(pool[q])) q = (q + 1) % pool.length;
    used.add(pool[q]);
    s.panes[j] = mk(pool[q], 2 + lt * 2 + r(20 + j) * 3, { dt: r(30 + j) * 40 });
    if (r(40 + j) < 0.12 && !living) s.panes[j].theme = MASH_THEMES[Math.floor(r(50 + j) * MASH_THEMES.length)];
  }
  const names = Object.values(s.panes).map((p) => p.title);
  s.tabs = [{ title: names[0], icon: s.panes[0].icon || KIND_ICON[s.panes[0].k || "term"] }, TABS[1 + (i % 2)], { title: names[n - 1], icon: "term" }].slice(0, o.W ? 2 : 3);
  s.tab = i % (o.W ? 2 : 3) === 1 ? 1 : 0;
  if (!o.W && r(6) < 0.3) {
    const tool = ["files", "search", "git", "agent", "github"][Math.floor(r(7) * 5)];
    s.side = { tool, w: 240, open: { src: 1, comp: 1, shell: r(8) < 0.6 }, sel: "Workspace.tsx", q: "restore", n: 2 + lt * 8, staged: 2, msg: "Float a pane on the rail", n2: 0 };
    if (tool === "agent") s.side.n = 120 + lt * 260;
  }
  const bounds = wsBox(s), B = rects(LAYS[li], bounds);
  // Every shot arrives mid-rearrangement: out of some other layout, into its own.
  const A = rects(LAYS[(li + 1 + Math.floor(r(9) * (LAYS.length - 1))) % LAYS.length], bounds);
  s.rects = lt < 0.34 ? mixRects(A, B, eback(lt / 0.34)) : B;
  s.focus = String(Math.floor(r(11) * n));
  if (r(12) < 0.32 && !o.W) {
    const key = VIEWS[Math.floor(r(13) * VIEWS.length)], w = 400 + r(14) * 120, h = 250 + r(15) * 70;
    s.popups = [{ p: mk(key, lt, { dt: i }), x: lerp(40, bounds.w - w - 40, frac(r(16) + lt * 0.35)), y: bounds.h - h - 14, w, h, focus: 1 }];
  }
  // A drag in flight: the ghost under the pointer, the half it would land in.
  if (!o.W && r(17) < 0.55) {
    const c = mashCursor(b), org = wsOrigin(s), hit = hitEdge(B, c.x - org.x, c.y - org.y);
    const from = String((Number(s.focus) + 1) % n);
    if (hit && hit.id !== from) {
      s.drop = half(B[hit.id], hit.e);
      s.grab = from;
      s.ghost = { x: c.x + 14, y: c.y + 12, title: s.panes[from].title, icon: s.panes[from].icon || KIND_ICON[s.panes[from].k || "term"] };
    }
  }
  return s;
}

// ── scenes ────────────────────────────────────────────────────────────────
function intro(F, b) {
  if (b < 8) {
    const l1 = "terminals forget.", l2 = "the command you were halfway through.", l3 = "the screen. the agent, forty minutes in.";
    const n1 = Math.floor(seg(b, 0.6, 2.6) * l1.length), n2 = Math.floor(seg(b, 4, 5.4) * l2.length), n3 = Math.floor(seg(b, 5.6, 7) * l3.length);
    const cur = `<b style="display:inline-block;width:.55em;height:1em;background:var(--gold);vertical-align:-.12em;${frac(b * 1.25) > 0.55 && (b < 0.6 || (b > 2.6 && b < 4)) ? "opacity:0" : ""}"></b>`;
    F.over += `<div style="position:absolute;left:110px;top:250px;font:700 62px/1.2 var(--mono);color:#fff;letter-spacing:-.04em;white-space:pre"><i style="color:var(--gold)">❯ </i>${l1.slice(0, n1)}${b < 4 ? cur : ""}</div>`;
    if (b >= 4) F.over += `<div style="position:absolute;left:110px;top:350px;font:400 30px/1.6 var(--mono);color:#8a8a8a;letter-spacing:-.03em;white-space:pre">${l2.slice(0, n2)}${b < 5.6 ? cur : ""}<br>${l3.slice(0, n3)}${b >= 5.6 ? cur : ""}</div>`;
    if (b >= 7.25) { F.over += `<div style="position:absolute;left:110px;top:475px;font:700 62px/1 var(--mono);color:#e35a5a;letter-spacing:-.04em">gone.</div>`; F.fx.rgb = 10 * Math.exp(-(b - 7.25) * 5); F.fx.glitch = b < 7.5 ? 50 : 0; }
    return;
  }
  // Glimpses of what is coming, more of them as the roll tightens.
  const div = b < 12 ? 2 : b < 14 ? 4 : 8, on = b < 12 ? frac(b * div) > 0.72 : frac(b * div) > 0.5;
  if (on && b < 15.5) {
    F.wins = [mashShot(Math.floor(b * div) + 400, 0.5, b * 3)];
    F.cam.s = 1.05; F.fx.glitch = 30; F.fx.rgb = 5;
    return;
  }
  if (b < 12) {
    const i = Math.floor(b) - 8, w = ["WHAT IF", "IT", "JUST", "DIDN’T?"][i], lt = frac(b), flip = i % 2;
    if (flip) F.bg = `<div style="position:absolute;inset:0;background:var(--gold)"></div>`;
    F.over += word(w, w.length > 5 ? 230 : 330, { s: 1 + 1.4 * Math.pow(1 - eout(lt * 3.4), 2), color: flip ? "#0b0900" : null, rot: flip ? -3 : 2 });
    F.fx.shake = 12 * Math.exp(-lt * 6);
  } else if (b < 15.5) {
    const VERS = [];
    for (let minor = 1; minor <= 9; minor++) for (let patch = 0; patch <= (minor === 9 ? 12 : 6); patch++) VERS.push(`0.${minor}.${patch}`);
    const v = VERS[Math.min(VERS.length - 1, Math.floor(Math.pow(seg(b, 12, 15.4), 0.8) * VERS.length))];
    F.over += word("v" + v, 250, { mono: 1, color: "#fff", s: 1 + 0.05 * Math.exp(-frac(b * div) * 6) });
    F.over += `<div style="position:absolute;left:0;right:0;top:560px;text-align:center;font:700 22px var(--mono);color:#666;letter-spacing:.3em">${"▮".repeat(Math.floor(seg(b, 12, 15.4) * 30))}<i style="color:#222">${"▮".repeat(30 - Math.floor(seg(b, 12, 15.4) * 30))}</i></div>`;
  }
}

function logoScene(F, b) {
  const lt = b - 16, dive = seg(b, 19.5, 20);
  const s = (1 + 1.6 * Math.pow(1 - eout(lt * 2.2), 2)) * (1 + 0.04 * Math.exp(-frac(b) * 6)) * (1 + dive * dive * 7);
  F.bg = `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 46%,#241c05,#000 70%)"></div>`;
  F.over += tape("JTERM 1.0", 86, -5, F.t, 1) + tape("OUT NOW", 590, 4, F.t, -1, true);
  F.over += `<div style="opacity:${1 - dive}">${lockup(s)}</div>`;
  if (lt > 1) F.over += `<div style="position:absolute;left:0;right:0;top:468px;text-align:center;font:700 26px var(--mono);color:#fff;letter-spacing:.02em;opacity:${(1 - dive) * eout(seg(lt, 1, 1.3))}">the terminal that <i style="color:var(--gold)">remembers</i>.</div>`;
  F.fx.invert = lt > 0.9 && frac(b) < 0.14 && b < 19.9;
  F.fx.shake = 16 * Math.exp(-lt * 3);
}

const SPLIT_KEYS = [[20, "a"], [21, ["h", "a", "b"]], [22, ["h", "a", ["v", "b", "c"]]], [23, ["h", ["v", "a", "d"], ["v", "b", "c"]]], [24, ["h", ["v", "a", "d"], ["v", "b", "c", "e"]]], [25, ["h", ["v", "a", "d"], ["v", "b", ["h", "c", "f"], "e"]]]];
function splitScene(F, b) {
  const s = { tabs: TABS, panes: { a: mk("cargo", b - 20), b: mk("vitest", b - 21), c: mk("htop"), d: mk("gitlog", b - 23), e: mk("logs"), f: mk("python", b - 25) } };
  const bounds = wsBox(s);
  s.rects = layoutAt(b, SPLIT_KEYS, bounds, 0.45);
  const z = b < 27.2 ? eback(seg(b, 26, 26.45)) : 1 - eout(seg(b, 27.2, 27.6));
  if (b >= 26 && z > 0) { const r = s.rects.c; s.rects.c = { x: lerp(r.x, 0, z), y: lerp(r.y, 0, z), w: lerp(r.w, bounds.w, z), h: lerp(r.h, bounds.h, z), z: 30 }; }
  s.focus = b < 21 ? "a" : b < 22 ? "b" : b < 23 ? "c" : b < 24 ? "d" : b < 25 ? "e" : b < 26 ? "f" : "c";
  F.wins = [s];
  F.cam.s = lerp(0.55, 1, eback(seg(b, 20, 20.5)));
  for (const k of [21, 23, 25]) keys(F, ["Mod", "D"], k);
  for (const k of [22, 24]) keys(F, ["Mod", "Shift", "D"], k);
  keys(F, ["Mod", "Enter"], 26); keys(F, ["Mod", "Enter"], 27.2);
  tag(F, "Splits like tmux", 20);
  note(F, b < 26 ? "split · focus · resize — all from the keyboard" : "zoom one, and back", 20.6, 40, 596);
}

const L0 = ["h", ["v", "a", "d"], ["v", "b", "c"]], L1 = ["h", "a", ["v", "b", ["h", "c", "d"]]], L2 = ["v", "b", "a", ["h", "c", "d"]], L3 = ["v", ["h", "c", "b"], "a", "d"], L4 = ["v", ["h", "c", "b"], ["h", "a", ["v", "s1", "s2"]], "d"];
const DRAGS = [{ id: "d", g: 29, r: 30, to: "c", e: "r", L: L0 }, { id: "a", g: 31, r: 32.5, to: "b", e: "b", L: L1 }, { id: "c", g: 33.5, r: 34.75, to: "b", e: "l", L: L2 }, { tab: 1, g: 36, r: 38, to: "a", e: "r", L: L3 }];
function dragScene(F, b) {
  const gone = seg(b, 38, 38.3);
  const s = {
    tabs: [TABS[0], { ...TABS[1], gone: b >= 36 && b < 38, w: b >= 38 ? 208 * (1 - eout(gone)) : undefined }, TABS[2]].filter((x) => !(x.w != null && x.w < 3)),
    panes: { a: mk("claude", 0, { n: 520 + (b - 28) * 42 }), b: mk("logs"), c: mk("htop"), d: mk("train"), s1: mk("ssh", (b - 38) * 1.4), s2: mk("k8s", (b - 38) * 1.4) },
  };
  const bounds = wsBox(s), o = wsOrigin(s);
  s.rects = layoutAt(b, [[28, L0], [30, L1], [32.5, L2], [34.75, L3], [38, L4]], bounds, 0.5);
  const path = [[28, 860, 250]], clicks = [];
  for (const d of DRAGS) {
    const R = rects(d.L, bounds);
    const gp = d.tab != null ? { x: 208 * d.tab + 80, y: 17 } : { x: o.x + R[d.id].x + 11, y: o.y + R[d.id].y + 11 };
    const tp = edgePt(R[d.to], d.e);
    path.push([d.g - 0.14, gp.x, gp.y], [d.g + 0.06, gp.x, gp.y], [d.r - 0.22, tp.x + o.x, tp.y + o.y], [d.r + 0.3, tp.x + o.x, tp.y + o.y]);
    clicks.push(d.g, d.r);
    if (b >= d.g && b < d.r) {
      const c = track(b, path);
      if (d.tab == null) s.grab = d.id;
      s.ghost = { x: c.x + 14, y: c.y + 12, title: d.tab != null ? TABS[1].title : s.panes[d.id].title, icon: d.tab != null ? "server" : s.panes[d.id].icon, tab: d.tab != null };
      if (seg(b, d.g, d.r) > 0.45) s.drop = half(R[d.to], d.e);
      s.focus = d.id;
    }
  }
  path.push([40, 728, 388]);
  F.cursor = { ...track(b, path), click: since(b, clicks), down: DRAGS.some((d) => b >= d.g && b < d.r) };
  F.wins = [s];
  if (b < 36) { tag(F, "Drag a pane anywhere", 28); note(F, "by its grip. nothing restarts — the shell never notices.", 28.6, 40, 596); }
  else { tag(F, "Fold a tab into a split", 36); note(F, "drag it out of the strip, drop it on a pane.", 36.5, 40, 596); }
}

function popupScene(F, b) {
  const tabAt = [[44.5, 1], [45, 2], [45.5, 0], [46, 1], [46.5, 2], [47, 0]];
  let tab = 0;
  for (const [k, v] of tabAt) if (b >= k) tab = v;
  const s = { tabs: TABS, tab, focus: "a" };
  const bounds = wsBox(s);
  const A = ["h", [0.55, 0.45], "a", ["v", "b", "c"]], B = ["h", [0.55, 0.45], "a", "b"];
  const cPane = mk("nvim");
  if (tab === 0) {
    s.panes = { a: mk("claude", 0, { n: 900 + (b - 40) * 40 }), b: mk("vite", b - 36), c: cPane };
    s.rects = layoutAt(b, [[40, A], [41.25, B]], bounds, 0.45);
    if (b >= 41.25) delete s.rects.c;
  } else if (tab === 1) {
    s.theme = "tokyo"; s.panes = { ssh: mk("ssh"), k8s: mk("k8s"), docker: mk("docker") };
    s.rects = rects(["v", [0.55, 0.45], "ssh", ["h", "k8s", "docker"]], bounds); s.focus = "ssh";
  } else {
    s.theme = "gruvbox"; s.panes = { md: mk("md"), rs: mk("rs") };
    s.rects = rects(["h", "md", "rs"], bounds); s.focus = "rs";
  }
  // The menu, then the pane lifting out of the layout onto the rail.
  if (b >= 40.25 && b < 41.25) {
    s.menus = [{ x: 724, y: 400, w: 172, hi: b >= 40.55 ? 4 : -1, items: [["Split right", "Mod+D"], ["Split down", "Mod+⇧D"], ["Zoom", "Mod+↵"], "-", "Move to  ▸", "Icon  ▸", "Pane theme  ▸", "-", "Close"] }];
    if (b >= 40.72) s.menus.push({ x: 894, y: 485, w: 176, hi: b >= 40.95 ? 1 : -1, items: ["#Move to", "Pop-up rail", "Beside “claude”", "A new tab", "A new window"] });
  }
  const from = rects(A, bounds).c, railY = bounds.h - 300 - 14;
  const px0 = track(b, [[42.2, 740, 0], [43.2, 90, 0], [43.4, 90, 0], [44.2, 400, 0]]).x;
  const min = b >= 47.4;
  if (b >= 41.25) {
    const p = eback(seg(b, 41.25, 41.75));
    s.popups = [{ p: cPane, x: lerp(from.x, px0, p), y: min ? bounds.h - 37 : lerp(from.y, railY, p), w: lerp(from.w, 470, p), h: lerp(from.h, 300, p), focus: 1, min }];
  }
  const hold = { x: px0 + 200, y: 34 + railY + 11 };
  F.cursor = { ...track(b, [[40, 728, 388], [40.2, 728, 388], [40.55, 790, 497], [40.72, 880, 497], [40.95, 940, 521], [41.6, 940, 521], [42.1, 940, 34 + railY + 11], [42.2, hold.x, hold.y]].concat(
    b < 44.2 && b >= 42.2 ? [[b, hold.x, hold.y]] : [[44.2, 600, hold.y]], [[44.45, 312, 17], [44.6, 312, 17], [44.95, 520, 17], [45.1, 520, 17], [45.45, 104, 17], [45.6, 104, 17], [45.95, 312, 17], [46.1, 312, 17], [46.45, 520, 17], [46.6, 520, 17], [46.95, 104, 17], [47.05, 104, 17], [47.38, 400 + 470 - 52, 34 + railY + 11]])),
    click: since(b, [40.25, 41.25, 42.2, 44.2, 44.5, 45, 45.5, 46, 46.5, 47, 47.4]), down: b >= 42.2 && b < 44.2 };
  F.wins = [s];
  F.cam.s = lerp(1, 1.45, ease(seg(b, 40, 40.3)) * (1 - ease(seg(b, 41.2, 41.6)))); F.cam.ox = 860; F.cam.oy = 480;
  if (b < 44.2) { tag(F, "Float a pane over everything", 40); note(F, "a pop-up rides a rail along the bottom.", 41.3, 40, 596); }
  else { tag(F, "…and it stays while you switch tabs", 44.2); note(F, "each tab in its own theme, if you like.", 44.6, 40, 596); }
}

const FAIL = [P + "cargo test", "«G:   Compiling» jterm v1.0.0 (/home/j/jterm/src-tauri)", "«R:error[E0308]»«w:: mismatched types»", "  «b:-->» src/pty.rs:212:24", "   «b:|»", "«b:212 |»     resize(size.cols, rows as u32)", "   «b:|»                       «r:^^^^^^^^^^^ expected `u16`, found `u32`»", "", "«R:error»«w:: could not compile `jterm` (lib) due to 1 previous error»"];
const PASS = ["«G:   Compiling» jterm v1.0.0 (/home/j/jterm/src-tauri)", "«G:    Finished» `test` profile in 3.12s", "«G:     Running» unittests src/lib.rs", "", "running 14 tests", "test pty::resize_keeps_rows ... «g:ok»", "test pty::reader_survives_eof ... «g:ok»", "test pty::cell_size_in_pixels ... «g:ok»", "", "test result: «G:ok». 14 passed; 0 failed", P];
function rowY(name, open) {
  const vis = {}; let i = 0;
  for (const [, , nm, key, parent] of TREE) {
    const show = !parent || (open[parent] && vis[parent]);
    if (key) vis[key] = show;
    if (!show) continue;
    if (nm === name) return 34 + 28 + i * 22 + 11;
    i++;
  }
  return 100;
}
function sidebarScene(F, b) {
  const tool = b < 52.5 ? "files" : b < 56.4 ? "search" : b < 60.4 ? "git" : "agent";
  const open = { src: b >= 49, comp: b >= 49.6, shell: b >= 50.2 };
  const staged = b < 57 ? 0 : b < 57.5 ? 1 : b < 58 ? 2 : 3, msg = "Restore unsubmitted input after a crash";
  const side = { tool, w: 240 * eout(seg(b, 48, 48.5)), open, sel: b >= 51 ? "Workspace.tsx" : null,
    q: "restore".slice(0, Math.floor(seg(b, 53, 54.3) * 7.99)), n: (b - 53.5) * 6,
    staged, msg: b >= 58.2 ? msg.slice(0, Math.floor(seg(b, 58.2, 59.4) * msg.length)) : "", press: b >= 59.6 && b < 59.8, done: b >= 59.8,
    menu: (b >= 52 && b < 52.5) || (b >= 56 && b < 56.4) || (b >= 60 && b < 60.4) };
  if (tool === "agent") side.n = (b - 60.5) * 150;
  const typed = "cargo test pty";
  const a = { title: "cargo test", icon: "cpu", c: FAIL.concat(b >= 62.3 ? [P + typed.slice(0, Math.floor(seg(b, 62.3, 62.9) * typed.length))] : [P], b >= 63 ? PASS.slice(0, Math.floor((b - 63) * 14) + 1) : []), cur: b < 63 };
  const s = { tabs: TABS, side, focus: "a", panes: { a, b: mk("vite", b - 44), c: mk("gitlog") } };
  s.rects = rects(["h", [0.58, 0.42], "a", ["v", "b", "c"]], wsBox(s));
  if (side.menu) s.menus = [{ x: 6, y: 62, w: 130, hi: frac(b) > 0.2 ? { 52: 1, 56: 2, 60: 4 }[Math.floor(b)] : { 52: 0, 56: 1, 60: 2 }[Math.floor(b)], items: Object.values(TOOLS).map(([icn, label]) => ic(icn) + label) }];
  const bounds = wsBox(s);
  if (b >= 51 && b < 60) {
    const p = eback(seg(b, 51, 51.45)), jump = b >= 55.3;
    s.popups = [{ p: mk("tsx", 0, { hl: jump ? 9 : null, top: jump ? 4 * eout(seg(b, 55.3, 55.6)) : 0 }), x: 170, y: lerp(bounds.h, 205, p), w: 560, h: 300, focus: 1 }];
    if (b > 59.5) s.popups[0].y = lerp(205, bounds.h, eout(seg(b, 59.5, 60)));
  }
  const gy = (st) => 34 + 28 + 24 + st * 22 + 24 + 11;
  const sw = [22, 48];
  F.cursor = { ...track(b, [[48, 500, 300], [48.9, 70, rowY("src", {})], [49.1, 70, rowY("src", {})], [49.5, 96, rowY("components", open)], [49.7, 96, rowY("components", { src: 1 })], [50.1, 108, rowY("shell", { src: 1, comp: 1 })], [50.3, 108, rowY("shell", { src: 1, comp: 1 })], [50.9, 130, rowY("Workspace.tsx", { src: 1, comp: 1, shell: 1 })], [51.5, 130, rowY("Workspace.tsx", { src: 1, comp: 1, shell: 1 })],
    [51.95, ...sw], [52.1, ...sw], [52.45, 50, 102], [52.6, 50, 102], [53, 120, 76], [54.6, 120, 76], [55.25, 150, 205], [55.7, 150, 205],
    [55.95, ...sw], [56.1, ...sw], [56.35, 50, 126], [56.5, 50, 126], [56.95, 218, gy(0)], [57.1, 218, gy(0)], [57.45, 218, gy(1)], [57.6, 218, gy(1)], [57.95, 218, gy(2)], [58.2, 218, gy(2)], [59.55, 120, 290], [59.9, 120, 290],
    [59.97, ...sw], [60.1, ...sw], [60.35, 50, 174], [60.6, 50, 174], [62, 560, 250], [64, 600, 300]]),
    click: since(b, [49, 49.6, 50.2, 51, 52, 52.5, 55.3, 56, 56.4, 57, 57.5, 58, 59.6, 60, 60.4]) };
  if (tool === "files") side.hot = b < 49 ? (b > 48.8 ? "src" : null) : b < 49.6 ? (b > 49.4 ? "components" : null) : b < 50.2 ? (b > 50 ? "shell" : null) : b < 51 && b > 50.8 ? "Workspace.tsx" : null;
  if (tool === "search" && b >= 55.1) side.hot = "src/components/shell/Workspace.tsx212";
  if (tool === "git" && b < 58) side.hot = GIT_FILES[staged][1];
  F.wins = [s];
  const names = { files: "Files", search: "Search", git: "Git", agent: "Agent" }, starts = { files: 48, search: 52.5, git: 56.4, agent: 60.4 };
  tag(F, `Sidebar <i style="opacity:.45">/</i> ${names[tool]}`, starts[tool], { x: 880, y: 642, rot: 2 });
  note(F, { files: "four tools that follow the focused terminal’s directory.", search: "text and file names, as you type. honours .gitignore.", git: "stage · commit · diff · pull · push.", agent: "Claude Code, Codex or Gemini — wired to jterm’s own MCP server." }[tool], starts[tool] + 0.4, 500, 600);
  note(F, "← typed by the agent", 62.4, 610, 184, 64);
  // Lean in: the sidebar is small type.
  F.cam.s = lerp(1, 1.3, ease(seg(b, 48.2, 49)) * (1 - ease(seg(b, 63, 64)))); F.cam.ox = 0; F.cam.oy = 0;
}

// ── issue → artifact → diff → pull request, in one window ─────────────────
const BENCH_LOG = [
  [64, "«a:✱» «w:Claude Code» «d:· ~/jterm · jterm MCP connected»"], [64, ""],
  [66.6, ""], [66.8, "«g:●» «w:Bash» gh issue view 212"], [67, "  «d:└ Pop-up forgets its size after a restart»"], [67.3, "«g:●» «w:Read» src/lib/rail.ts"], [67.6, "«g:●» «w:Edit» src/lib/rail.ts «g:+9» «r:−3»"],
  [68, "«g:●» «w:jterm»·create_artifact(«y:\"Pop-up geometry\"», html)"], [68.2, "  «d:└ opened in a pane»"],
  [70, "«g:●» «w:Bash» npm test"], [71, "  «d:└» «g:413 passed» «d:(413)»"],
  [72, "«g:●» «w:Bash» git diff"], [72.2, "  «d:└ 1 file changed, 9 insertions(+), 3 deletions(-)»"],
  [75, "«g:●» «w:Bash» git commit -am «y:\"Remember a pop-up's size\"»"], [75.5, "«g:●» «w:Bash» gh pr create --fill"], [76, "  «d:└ github.com/JacobFV/jterm/pull/213»"],
  [78.2, ""], [78.2, "Opened «b:#213». Checks are green — it is yours to merge."],
];
function benchScene(F, b) {
  const ask = "fix #212", typed = ask.slice(0, Math.floor(seg(b, 65.6, 66.4) * ask.length + 0.01));
  const log = BENCH_LOG.filter(([k]) => b >= k).map(([, l]) => l);
  log.splice(2, 0, "«d:>» " + typed);
  const merged = b >= 79;
  const s = {
    tabs: [TABS[0], { title: "#213 Remember a pop-up's size", icon: "pr" }, TABS[2]], focus: b < 65 ? "t" : b < 68 ? "i" : b < 72 ? "a" : b < 76 ? "d" : "p",
    side: { tool: "github", w: 240, prs: b >= 76 ? 0 : 1, hot: b >= 76 ? 213 : b >= 64.7 && b < 68 ? 212 : null },
    panes: {
      t: { title: "claude", icon: "spark", c: log, cur: b >= 65.4 && b < 66.6, blink: 1 },
      i: mk("issue", 0, { closed: merged }), a: mk("art", 0, { n: seg(b, 68.6, 70) }),
      d: mk("diffv", 0, { n: (b - 72.1) * 30, split: b >= 74, press: b >= 74 && b < 74.2 ? "Split" : null }),
      p: mk("prv", 0, { checks: clamp(Math.floor((b - 76.2) * 2.4), 0, 4), merged, confirm: b >= 78.4, press: (b >= 78.3 && b < 78.4) || (b >= 78.9 && b < 79) }),
      w: mk("web"),
    },
  };
  const bounds = wsBox(s), o = wsOrigin(s);
  const K = [[64, "t"], [65, ["h", "t", "i"]], [68, ["h", "t", ["v", [0.42, 0.58], "i", "a"]]], [72, ["h", [0.4, 0.6], ["v", "t", "a"], "d"]], [76, ["h", [0.4, 0.6], ["v", "t", "w"], ["v", [0.6, 0.4], "p", "d"]]]];
  s.rects = layoutAt(b, K, bounds, 0.45);
  const R3 = rects(K[3][1], bounds), R4 = rects(K[4][1], bounds);
  const chip = { x: o.x + R3.d.x + R3.d.w - 30, y: o.y + R3.d.y + 22 + 13 };
  // The merge button: under the title, the meta line, the tabs, one comment and four checks.
  const btn = { x: o.x + R4.p.x + 80, y: o.y + R4.p.y + 22 + 300 };
  F.cursor = { ...track(b, [[64, 600, 300], [64.8, 150, 143], [65.1, 150, 143], [65.5, 420, 250], [71.5, 430, 260], [73.8, chip.x, chip.y], [74.3, chip.x, chip.y], [76.4, 150, 97], [77.6, 150, 97], [78.25, btn.x - 40, btn.y], [78.5, btn.x - 40, btn.y], [78.85, btn.x + 330, btn.y], [80, btn.x + 330, btn.y]]), click: since(b, [65, 74, 78.4, 79]) };
  F.wins = [s];
  // Lean toward whichever pane the bar is about.
  const part = Math.floor((b - 64) / 4), lt = b - 64 - part * 4, env = ease(seg(lt, 0.5, 1.3)) * (1 - ease(seg(lt, 3.5, 4)));
  const aim = [[1.05, 640, 300], [1.3, 1160, 600], [1.22, 1280, 380], [1.24, 1280, 120]][part];
  F.cam.s = lerp(1, aim[0], env); F.cam.ox = aim[1]; F.cam.oy = aim[2];
  const tags = [["Issues", "one click in the sidebar. it is a pane like any other."], ["Artifacts", "the agent draws you a page instead of a wall of text."], ["Diffs", "unified or side by side — the tree, the index, any commit."], ["Pull requests", "checks, review, merge. your own <b style='color:var(--gold)'>gh</b> underneath."]][part];
  tag(F, tags[0], 64 + part * 4, { s: 1.25 });
  note(F, tags[1], 64 + part * 4 + 0.5, 40, 590);
  if (merged) { F.fx.rgb = 9 * Math.exp(-(b - 79) * 4); F.fx.shake = 8 * Math.exp(-(b - 79) * 5); }
  if (b >= 79.5) F.fx.dim = 1 - 0.5 * seg(b, 79.5, 80);
}

const CMD = "rsync -avz --partial ./renders/ deploy@prod-7:/srv/media/ --exclude '*.tmp'";
const SHELL = [P + "ls renders/ | wc -l", "4127", P + "du -sh renders/", "212G\trenders/", P + "ssh deploy@prod-7 df -h /srv/media | tail -1", "/dev/nvme1n1p1  3.6T  1.9T  1.6T  55% /srv/media"];
function breakdown(F, b) {
  const s = { tabs: [{ title: "renders", icon: "server" }], focus: "t" };
  const bounds = wsBox(s);
  s.rects = rects(["h", [0.58, 0.42], "t", "g"], bounds);
  const caption = (text, b0, b1) => { if (b >= b0 && b < b1) F.over += `<div style="position:absolute;left:0;right:0;top:548px;text-align:center"><span style="font:700 24px var(--mono);color:#fff;background:#000;padding:8px 18px;opacity:${eout(seg(b, b0, b0 + 0.4))}">${text}</span></div>`; };
  if (b < 70.75) {
    const k = Math.floor(ease(seg(b, 64.6, 69.9)) * 0.5 * CMD.length + seg(b, 64.6, 69.9) * 0.5 * CMD.length * 0.72);
    s.panes = { t: { title: "j@studio: ~/jterm", c: SHELL.concat([P + CMD.slice(0, k)]), blink: 1 }, g: mk("claude", 0, { n: 700 + (b - 64) * 34 }) };
    F.wins = [s];
    F.cam.s = 1 + 0.07 * seg(b, 64, 70);
    caption("you are halfway through typing this.", 65.5, 68);
    caption("the agent next door is forty minutes in.", 68, 70);
    if (b >= 70) {
      // The picture tube losing power: a line, then a dot, then nothing.
      const p1 = eout(seg(b, 70, 70.3)), p2 = seg(b, 70.3, 70.6);
      F.cam.sy = lerp(1, 0.004, p1); F.cam.sx = lerp(1, 0, p2 * p2); F.cam.bright = 1 + 6 * p1;
      F.fx.glitch = 60 * (1 - p1); F.fx.rgb = 12;
    }
    return;
  }
  if (b < 72) {
    if (b > 71 && frac(b * 4) < 0.7) F.over += `<div style="position:absolute;left:60px;top:70px;font:13px/1.5 var(--mono);color:#b33">[ 1841.220391] Kernel panic - not syncing: Fatal exception in interrupt<br>[ 1841.220412] ---[ end Kernel panic ]---</div>`;
    caption("and the machine dies.", 70.9, 72);
    return;
  }
  const back = eout(seg(b, 72, 72.5)), k = Math.floor(seg(b, 72.7, 73.2) * CMD.slice(0, 54).length);
  const resumed = b >= 79.15;
  s.panes = {
    t: { title: "j@studio: ~/jterm", c: SHELL.concat([P + `«glow:${CMD.slice(0, 54).slice(0, k)}»`]), blink: 1 },
    g: mk("claude", 0, { n: resumed ? 700 + 6 * 34 + (b - 79.15) * 420 : 700 + 6 * 34, cur: resumed, card: b >= 73.6 && !resumed ? { title: "This pane was running <b style='color:var(--brand)'>Claude Code</b> when the machine died.", cmd: "claude --resume 4f2a91c8-77de --model fable", a: "Resume", b: "Type it", press: b >= 79 ? 0 : -1 } : null }),
  };
  s.o = back;
  F.wins = [s];
  F.cam.s = lerp(0.96, 1, back);
  caption("jterm reopens. the command is typed back.", 72.4, 74.2);
  caption("no newline. nothing runs on your behalf.", 74.2, 76);
  const stamps = ["INPUT", "SCREEN", "PROCESS", "AGENT"];
  for (let i = 0; i < 4; i++) if (b >= 76 + i) {
    const p = eback(seg(b, 76 + i, 76.3 + i));
    F.over += `<div class="tag" style="left:${60 + i * 26}px;top:${290 + i * 74}px;font-size:46px;transform:rotate(${-4 + i * 2}deg) scale(${lerp(2.2, 1, p)});opacity:${clamp(p * 2)}">${stamps[i]} <i style="font-family:var(--mono)">✓</i></div>`;
  }
  if (b >= 76) {
    F.cursor = { ...track(b, [[76, 620, 420], [78.7, 742 + 60, 686], [80, 742 + 60, 686]]), click: since(b, [79]) };
    F.fx.shake = 5 * Math.exp(-frac(b) * 6);
    if (b >= 79.5) { F.fx.invert = frac(b * 8) < 0.5; F.fx.rgb = 8; }
    if (b >= 79.875) { F.wins = []; F.over = ""; F.cursor = null; F.fx.invert = false; }
  }
}

const STATIC_THEMES = ["dark", "gruvbox", "dracula", "nord", "monokai", "tokyo", "mocha", "latte", "solarized", "sollight", "rosepine", "everforest", "kanagawa", "synthwave", "phosphor", "amber", "blueprint", "parchment", "hotdog"];
const ALIVE = ["mandelbrot", "aurora", "rain", "warp", "lava", "lorenz"];
function themeScene(F, b) {
  const order = STATIC_THEMES.concat(ALIVE);
  const idx = b < 84.75 ? Math.min(18, Math.floor((b - 80) * 4)) : 19 + Math.min(5, Math.floor((b - 84.75) * 2));
  const theme = order[idx], lt = b - 80;
  const s = { theme, tabs: TABS, focus: "a", panes: { a: mk("claude", 0, { n: 500 + lt * 60 }), g: mk("gitlog"), n: mk("nvim"), h: mk("htop"), f: mk("fetch") } };
  s.rects = rects(["h", [0.52, 0.48], ["v", [0.62, 0.38], "a", "g"], ["v", [0.5, 0.5], "n", ["h", [0.45, 0.55], "h", "f"]]], wsBox(s));
  const first = clamp(idx - 6, 0, order.length - 13), items = [];
  for (let i = first; i < first + 13; i++) {
    if (i === 19) items.push("#Alive");
    const th = THEMES[order[i]];
    items.push(`<span class="sw3" style="background:${th.bg}"><b style="background:${th.r}"></b><b style="background:${th.g}"></b><b style="background:${th.b}"></b><b style="background:${th.accent}"></b></span>${THEME_NAMES[order[i]]}`);
  }
  const hiRow = items.findIndex((x) => x.includes(">" + THEME_NAMES[theme]));
  s.menus = [{ x: 150, y: 96, w: 210, hi: hiRow + 1, items: ["#Tab theme"].concat(items) }];
  let y = 96 + 4 + 20;
  for (let i = 0; i < hiRow; i++) y += items[i][0] === "#" ? 20 : 24;
  F.cursor = { x: 300 + 14 * Math.sin(b * 3), y: y + 12 };
  F.wins = [s];
  F.amb = THEMES[theme].amb;
  F.cam.s = 0.985; F.cam.ry = 3 * Math.sin(b * 0.4);
  if (b < 84.75) { tag(F, "30 themes", 80, { s: 1.5 }); note(F, "point at one — the terminal repaints under the pointer.", 80.5, 40, 580); }
  else { tag(F, "10 of them are alive", 84.75, { s: 1.3 }); note(F, THEME_NAMES[theme], 84.75, 40, 584); }
  F.fx.rgb = 5 * Math.exp(-frac((b - 80) * (b < 84.75 ? 4 : 2)) * 5);
}

// Cut lengths, in 16ths, for bars 22–27.
const CUTS = [[2, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 2], [2, 2, 1, 1, 2, 2, 1, 1, 2, 2], [2, 2, 2, 2, 1, 1, 1, 1, 2, 2], [2, 2, 2, 2, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]];
const BAR_INFO = [
  ["A pane can be anything", ["stl", "prv", "art", "web", "diffv", "md", "issue", "img"]],
  ["Sixel · Markdown · STL · web", ["plot", "md", "stl", "web", "img", "rs"]],
  ["ssh · vnc · rdp · tmux", ["ssh", "vnc", "k8s", "tmux", "docker", "rsync"]],
  ["Claude · Codex · Gemini", ["claude", "art", "codex", "diffv", "prv", "pytest"]],
  ["As many windows as you like", null],
  ["And it survives the crash", null],
];
function mashScene(F, b) {
  const bar = Math.floor((b - 88) / 4), cuts = CUTS[bar];
  let pos = 88 + bar * 4, idx = bar * 20, start = pos;
  for (const c of cuts) { if (b < pos + c / 4) { start = pos; break; } pos += c / 4; idx++; }
  const lt = b - start, [label, pool] = BAR_INFO[bar], r = (k) => rnd(idx * 7.7 + k);
  if (bar === 4) {
    // Several windows at once, each its own layout and theme.
    F.bg = `<div style="position:absolute;inset:0;background:linear-gradient(${120 + idx * 40}deg,#f2cd6b,#e0842f)"></div>`;
    const n = 2 + (idx % 2);
    for (let w = 0; w < n; w++) {
      const s = mashShot(idx * 3 + w + 900, lt, b, { W: 780, H: 470 });
      const p = eback(seg(lt, 0, 0.3));
      s.framed = 1; s.scale = 0.92 + 0.1 * rnd(idx + w);
      s.x = lerp(640, [30, 520, 260][(w + idx) % 3], p) + 20 * Math.sin(b + w); s.y = lerp(360, [40, 250, 150][(w + idx * 2) % 3], p);
      F.wins.push(s);
    }
    F.cursor = mashCursor(b);
  } else {
    const s = mashShot(idx, lt, b, { pool, living: bar === 5 ? r(1) < 0.4 : undefined });
    F.wins = [s];
    F.amb = THEMES[s.theme].amb;
    F.cursor = { ...mashCursor(b), down: !!s.ghost };
    if (r(2) < 0.3) {
      // Tilted, on a backdrop, like a product shot.
      s.framed = 1;
      F.bg = `<div style="position:absolute;inset:0;background:${r(3) < 0.5 ? "linear-gradient(135deg,#f2cd6b,#d9722a)" : "radial-gradient(circle at 30% 30%,#2b2b33,#050506)"}"></div>`;
      F.cam.s = 0.86 + 0.05 * r(4); F.cam.ry = (r(5) - 0.5) * 34; F.cam.rx = (r(6) - 0.5) * 16; F.cam.rz = (r(7) - 0.5) * 6;
      if (F.amb) F.amb = null, (s.theme = "dark");
    } else {
      F.cam.s = 1 + 0.22 * r(4); F.cam.ox = 200 + r(5) * 880; F.cam.oy = 150 + r(6) * 420;
    }
    F.cam.s += 0.03 * lt;
  }
  if (lt < 0.07) F.fx.glitch = 70;
  F.fx.rgb = 7 * Math.exp(-lt * 9);
  tag(F, label, 88 + bar * 4, { s: 1.25 });
  if (bar === 5 && b >= 111) {
    // The last beat: strobe.
    const k = Math.floor((b - 111) * 8);
    F.wins = []; F.cursor = null; F.over = ""; F.amb = null;
    F.bg = `<div style="position:absolute;inset:0;background:${k % 2 ? "var(--gold)" : "#000"}"></div>`;
    F.over = word(["SPLITS", "POP-UPS", "DIFFS", "PRS", "ISSUES", "AGENTS", "1.0", ""][k], 250, { color: k % 2 ? "#0b0900" : null, rot: (k % 3) - 1 });
    F.cam = {};
  }
}

const FEATURES = ["remembers what you were typing", "splits like tmux · panes that float", "files · search · git · agent", "pull requests · issues · diffs", "artifacts from your agent", "thirty themes, ten alive", "ssh · vnc · rdp · a browser", "survives the crash"];
function outro(F, b) {
  const lt = b - 112;
  if (b < 120) {
    const s = mashShot(Math.floor(b * 2) + 700, frac(b * 2) / 2, b);
    F.wins = [s]; F.amb = THEMES[s.theme].amb;
    F.cam.s = 1.15; F.cam.filter = "blur(5px) brightness(.32) saturate(1.3)";
    const sc = (1 + 1.5 * Math.pow(1 - eout(lt * 2.2), 2)) * (1 + 0.035 * Math.exp(-frac(b) * 6));
    F.over += tape("JTERM 1.0", 70, -4, F.t, 1) + tape("OUT NOW", 610, 3, F.t, -1, true) + lockup(sc, 318);
    const f = Math.floor(lt), p = eback(seg(frac(lt), 0, 0.3));
    F.over += `<div style="position:absolute;left:0;right:0;top:458px;text-align:center"><span style="display:inline-block;font:700 34px var(--mono);letter-spacing:-.02em;color:#0b0900;background:var(--gold);padding:6px 20px;transform:scale(${lerp(1.5, 1, p)}) rotate(${(f % 2 ? 1 : -1) * 1.5}deg)">${FEATURES[f]}</span></div>`;
    F.fx.shake = 14 * Math.exp(-lt * 3);
    return;
  }
  if (b < 124) {
    const url = "jacobfv.github.io/jterm", n = Math.floor(seg(b, 120.6, 122.2) * url.length);
    F.bg = `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 40%,#241c05,#000 70%)"></div>`;
    F.over += lockup(0.62 * (1 + 0.03 * Math.exp(-frac(b) * 6)), 190);
    F.over += `<div class="tag" style="left:640px;top:300px;font-size:64px;transform:translate(-50%,0) rotate(-2deg) scale(${lerp(2.4, 1, eback(seg(b, 120, 120.35)))})">Out now</div>`;
    F.over += `<div style="position:absolute;left:0;right:0;top:436px;text-align:center;font:700 54px var(--mono);color:#fff;letter-spacing:-.05em;white-space:pre"><i style="color:var(--gold)">❯ </i>${url.slice(0, n)}<b style="display:inline-block;width:.55em;height:1em;background:var(--gold);vertical-align:-.12em"></b></div>`;
    if (b >= 122.2) F.over += `<div style="position:absolute;left:0;right:0;top:540px;text-align:center;font:600 24px var(--mono);color:#9a9a9a;letter-spacing:.14em;opacity:${eout(seg(b, 122.2, 122.6))}">LINUX  ·  MACOS  ·  WINDOWS  ·  FREE</div>`;
    return;
  }
  const fade = 1 - ease(seg(b, 126.5, 129.5));
  F.over += `<div style="opacity:${fade}"><div style="position:absolute;left:640px;top:330px;transform:translate(-50%,-50%) scale(${1 + 0.5 * Math.pow(1 - eout((b - 124) * 2), 2)})">${ICON(260)}</div>
    <div style="position:absolute;left:0;right:0;top:500px;text-align:center;font:700 40px var(--mono);color:#fff;letter-spacing:-.04em">jterm <i style="color:var(--gold)">1.0</i></div></div>`;
  F.fx.shake = 14 * Math.exp(-(b - 124) * 3);
}

// ── one frame ─────────────────────────────────────────────────────────────
const FLASH = [[16, 1], [20, 0.7], [28, 0.5], [36, 0.3], [40, 0.4], [48, 0.5], [52.5, 0.2], [56.4, 0.2], [60.4, 0.2], [64, 0.5], [72, 0.6], [80, 1], [84.75, 0.4], [88, 0.6], [92, 0.3], [96, 0.6], [100, 0.3], [104, 0.6], [108, 0.4], [112, 1], [120, 0.6], [124, 1]];
const grooving = (b) => (b >= 16 && b < 63) || (b >= 80 && b < 124);

function frame(t) {
  // The bench scene was cut in at beat 64; everything after it is written in
  // the beats it had before, so it runs sixteen late.
  const real = t / BEAT, b = real >= 80 ? real - 16 : real, bench = real >= 64 && real < 80;
  const F = { t, b, bg: "", wins: [], over: "", cam: {}, cursor: null, fx: {}, amb: null };
  if (b < 16) intro(F, b);
  else if (b < 20) logoScene(F, b);
  else if (b < 28) splitScene(F, b);
  else if (b < 40) dragScene(F, b);
  else if (b < 48) popupScene(F, b);
  else if (bench) benchScene(F, b);
  else if (b < 64) sidebarScene(F, b);
  else if (b < 80) breakdown(F, b);
  else if (b < 88) themeScene(F, b);
  else if (b < 112) mashScene(F, b);
  else outro(F, b);
  // What the kick does to the picture.
  let flash = 0, hit = 0;
  for (const [fb, amt] of FLASH) if (b >= fb) { flash = Math.max(flash, amt * Math.exp(-(b - fb) * 5)); if (amt >= 0.6) hit = Math.max(hit, amt * Math.exp(-(b - fb) * 3.5)); }
  F.fx.flash = flash;
  F.fx.rgb = Math.max(F.fx.rgb || 0, hit * 16, (bench || grooving(b)) ? 1.6 * Math.exp(-frac(b) * 7) : 0);
  F.fx.shake = Math.max(F.fx.shake || 0, hit * 12);
  if (bench || grooving(b)) F.cam.s = (F.cam.s || 1) * (1 + 0.022 * Math.exp(-frac(b) * 6));
  return F;
}

const $ = (id) => document.getElementById(id);
function renderAt(t) {
  const F = frame(t), frameNo = Math.round(t * 60);
  $("bg").innerHTML = F.bg;
  $("ui").innerHTML = F.wins.map((w) => winHtml(w, t)).join("");
  const amb = $("amb");
  if (F.amb && AMB[F.amb]) { amb.style.display = "block"; AMB[F.amb](amb.getContext("2d"), t); } else amb.style.display = "none";
  const c = F.cam, sh = F.fx.shake || 0;
  const dx = sh * (rnd(frameNo * 1.7) - 0.5) * 2, dy = sh * (rnd(frameNo * 2.3 + 5) - 0.5) * 2;
  const cam = $("cam");
  cam.style.transformOrigin = `${c.ox ?? 640}px ${c.oy ?? 360}px`;
  cam.style.transform = `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px) rotateX(${c.rx || 0}deg) rotateY(${c.ry || 0}deg) rotateZ(${c.rz || 0}deg) scale(${(c.s || 1) * (c.sx ?? 1)},${(c.s || 1) * (c.sy ?? 1)})`;
  cam.style.filter = [c.filter || "", c.bright ? `brightness(${c.bright})` : "", F.fx.dim != null ? `brightness(${F.fx.dim})` : ""].join(" ").trim() || "none";
  $("over").style.transform = `translate(${(-dx * 0.6).toFixed(2)}px,${(-dy * 0.6).toFixed(2)}px)`;
  $("over").innerHTML = F.over;
  const cur = $("cursor");
  if (F.cursor) {
    const k = F.cursor.click ?? 99;
    cur.style.display = "block";
    cur.style.transform = `translate(${F.cursor.x.toFixed(1)}px,${F.cursor.y.toFixed(1)}px)`;
    cur.innerHTML = (k < 0.5 ? `<div class="ring" style="left:${-8 - k * 60}px;top:${-8 - k * 60}px;width:${16 + k * 120}px;height:${16 + k * 120}px;opacity:${1 - k * 2}"></div>` : "") +
      `<svg viewBox="0 0 24 28" style="transform:scale(${F.cursor.down || k < 0.12 ? 0.86 : 1});transform-origin:3px 2px"><path d="M3 2V22L8.500 17 12 25.500 15.500 24 12 15.500H19.500Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  } else cur.style.display = "none";
  // Post: the chromatic split and tearing are one SVG filter on the stage.
  const rgb = F.fx.rgb || 0, gl = F.fx.glitch || 0, stage = $("stage");
  const filters = [];
  if (rgb > 0.4 || gl > 0) {
    $("fxR").setAttribute("dx", (rgb * 0.66).toFixed(2)); $("fxB").setAttribute("dx", (-rgb * 0.66).toFixed(2));
    $("fxDisp").setAttribute("scale", gl.toFixed(1)); $("fxNoise").setAttribute("seed", frameNo % 997);
    filters.push("url(#fx)");
  }
  if (F.fx.invert) filters.push("invert(1) hue-rotate(180deg)");
  stage.style.filter = filters.join(" ") || "none";
  $("post").innerHTML = `<div class="scan"></div><div class="vig"></div>` + (F.fx.flash > 0.01 ? `<div style="position:absolute;inset:0;background:#fff;opacity:${(F.fx.flash * 0.85).toFixed(3)}"></div>` : "");
}
window.renderAt = renderAt;
if (location.hash) renderAt(parseFloat(location.hash.slice(1)));

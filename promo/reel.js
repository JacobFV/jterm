// Fifteen quiet seconds for the setup dialog: the film's scenes, cut together
// and played straight. Loaded after multitask.js by reel.py.
//
// The film sells with flashes, shakes, stickers and captions, all of which live
// in layers this simply does not draw. What is left is the app being used. Its
// springy layout easing goes too, through `calmMotion`, and each scene is slowed
// to a pace somebody reading a dialog beside it can follow. Every cut is a plain
// cut, and the last leads back to the first.

window.calmMotion = true;
const REEL_FPS = 30;

/** Local seconds to film beats: straight lines between `[seconds, beat]` keys. */
function beatAt(keys, u) {
  for (let i = 0; i < keys.length - 1; i++) {
    const [u0, b0] = keys[i], [u1, b1] = keys[i + 1];
    if (u < u1) return lerp(b0, b1, clamp((u - u0) / (u1 - u0)));
  }
  return keys[keys.length - 1][1];
}
const filmShot = (scene, keys) => (F, u) => {
  F.b = beatAt(keys, u);
  F.t = F.b * BEAT;
  scene(F, F.b);
};

// ── the wall of agents, with the pointer going from one to the next ───────
const WALL_SCALE = 2 / 3;
let wall = null;
function wallShot(F, u) {
  wall = wall || multitaskScene(1920, 1080);
  const middle = (id) => {
    const r = wall.rects[id];
    return { x: (r.x + r.w / 2) * WALL_SCALE, y: (34 + r.y + r.h / 2) * WALL_SCALE };
  };
  const [i, n, d] = ["i", "n", "d"].map(middle);
  const focus = u < 0.72 ? "i" : u < 1.42 ? "n" : "d";
  const frame = Math.round(u * REEL_FPS);
  for (const id in wall.panes) Object.assign(wall.panes[id], { frame, focus: id === focus });
  F.wins = [Object.assign(wall, { focus, scale: WALL_SCALE })];
  F.cursor = {
    ...track(u, [[0, i.x, i.y], [0.2, i.x, i.y], [0.68, n.x, n.y], [0.9, n.x, n.y], [1.38, d.x, d.y], [2, d.x, d.y]]),
    click: since(u, [0.72, 1.42]) * 2,
  };
}

// ── the 3D viewer, turned by hand ─────────────────────────────────────────
function modelShot(F, u) {
  const c = track(u, [[0, 1040, 560], [0.32, 430, 330], [0.42, 430, 330], [1.02, 700, 440], [1.6, 330, 250], [1.9, 330, 250]]);
  const held = u >= 0.42 && u < 1.6;
  const x = u < 0.42 ? 430 : c.x, y = u < 0.42 ? 330 : c.y;
  // `stlBody` turns the mesh by time; this pins that to where the pointer is.
  F.t = (y - 330) * 0.016;
  const s = { tabs: TABS, focus: "m", panes: { m: mk("stl", 0, { dt: 1.1 + (x - 430) * 0.013 - F.t * 1.1 }), e: mk("rs"), i: mk("img") } };
  s.rects = rects(["h", [0.62, 0.38], "m", ["v", "e", "i"]], wsBox(s));
  F.wins = [s];
  F.cursor = { ...c, down: held, click: since(u, [0.42]) * 2 };
}

// [frames, how to draw it]. 450 frames, 15 seconds.
const SHOTS = [
  [60, wallShot],
  [60, filmShot(splitScene, [[0, 20.9], [2, 25.3]])],
  [72, filmShot(dragScene, [[0, 28.7], [2.4, 32.8]])],
  [57, modelShot],
  [54, filmShot(popupScene, [[0, 40.1], [1.8, 44.1]])],
  [51, filmShot(benchScene, [[0, 76.5], [1.7, 79.4]])],
  // A machine coming back: the draft typed in, then straight to the agent's
  // resume, skipping the wait the film filled with captions.
  [57, filmShot(breakdown, [[0, 72.45], [0.75, 73.9], [1.05, 78.5], [1.9, 79.45]])],
  [39, filmShot(themeScene, [[0, 84.8], [1.3, 87.7]])],
];
window.REEL_FRAMES = SHOTS.reduce((sum, [n]) => sum + n, 0);

window.reelFrame = function (frame) {
  let at = frame, i = 0;
  while (at >= SHOTS[i][0]) at -= SHOTS[i++][0];
  const F = { t: 0, b: 0, bg: "", wins: [], over: "", cam: {}, cursor: null, fx: {}, amb: null };
  SHOTS[i][1](F, at / REEL_FPS);
  // Whatever the scene asked of the overlay, the camera and the picture.
  Object.assign(F, { bg: "", over: "", cam: {}, fx: {}, clean: true });
  paint(F, F.t, frame);
};

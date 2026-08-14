/**
 * Every theme jterm ships, and the one rule that makes adding one cheap.
 *
 * A theme here is *a terminal palette and nothing else*. The chrome — surfaces,
 * hairlines, the four inks, the accent — is computed from that palette's
 * background and foreground rather than authored beside it. That is the same
 * commitment `index.css` already makes ("the shell chrome and the shell
 * contents cannot drift apart"), taken one step further: there is now no way to
 * write them down separately, so they cannot disagree even in principle. A new
 * theme is sixteen ANSI slots, a background and a foreground, and it is done.
 *
 * The two themes jterm shipped with are in here as `dark` and `light`, under
 * their own names, keeping those ids so a settings file written by an older
 * version still selects the thing it used to select.
 *
 * Some themes also name an `ambient`: a drawing that runs behind the panes.
 * Those are not decoration bolted on top — the terminal's own background goes
 * translucent (`veil`) so the drawing reads as the thing the text is sitting
 * over. See `lib/ambient.ts` for what each one draws.
 */

/** A drawing that runs behind the panes. Implemented in `lib/ambient.ts`. */
export type AmbientId = "mandelbrot" | "julia" | "nebula" | "aurora" | "rain" | "warp" | "lava";

/** The sixteen ANSI slots, plus the three colours a terminal needs besides. */
export interface Palette {
  bg: string;
  fg: string;
  cursor: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  /** The heading it sits under in the menu. Order follows `THEMES`. */
  group: string;
  /** What the platform should draw scrollbars and form controls as. */
  base: "dark" | "light";
  /**
   * The one accent, which means state and never category. Defaults to the
   * cursor colour, because a palette's cursor is already the colour its author
   * chose to mean "here, now, you" — which is what the accent is for.
   */
  accent?: string;
  ambient?: AmbientId;
  /**
   * How opaque the terminal's background sits over its ambient drawing. Lower
   * shows more weather and less contrast; only meaningful with `ambient`.
   */
  veil?: number;
  /**
   * The two colours the *chrome* is built between, when the terminal's own two
   * are the wrong pair to build one out of.
   *
   * Almost never needed, and deliberately awkward to reach for: the entire
   * point of this file is that a palette decides everything. But the ramps
   * below work by moving between the background and the foreground, and a
   * scheme whose two ends are the same lightness — Hotdog Stand's red and
   * yellow are both exactly 50% — has nothing for them to move along, so every
   * surface and every hairline comes out invisible against the last. Naming a
   * foreground here gives the chrome somewhere to go without touching a single
   * colour the terminal draws with.
   */
  chrome?: { bg?: string; fg?: string };
  palette: Palette;
}

/* ── Colour ──────────────────────────────────────────────────────────────── */

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** `t` is how much of `b` to take. Plain sRGB, which is what `color-mix` does
 *  by default and what the eye expects of a ramp between two near-neutrals. */
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The bare `H S% L%` form the tokens are written in.
 *
 * Bare rather than a full `hsl()` because every consumer wraps it themselves —
 * `hsl(var(--brand) / 0.28)` in the stylesheet, and Tailwind's own opacity
 * modifiers — and neither can do that to a finished colour.
 */
function hslTriple(c: RGB): string {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return `${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
}

/** HSL's own lightness, 0..1 — the axis the ramps below are built on. */
function lightness(c: RGB): number {
  return (Math.max(c[0], c[1], c[2]) + Math.min(c[0], c[1], c[2])) / 510;
}

/** `#rrggbb` with an alpha byte on the end — a form xterm parses. */
function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex}${byte.toString(16).padStart(2, "0")}`;
}

/* ── Palette → every token ───────────────────────────────────────────────── */

/**
 * The ramps. Each number is how far from the background towards the foreground
 * a surface sits, or how far from the foreground towards the background an ink
 * does — so the same table produces a dark theme and a light one without
 * knowing which it is looking at.
 */
const SURFACE = [0, 0.025, 0.05, 0.085];
const HAIRLINE = [0.13, 0.2];
const INK = [0, 0.28, 0.54, 0.72];

export function themeVars(theme: Theme): Record<string, string> {
  const p = theme.palette;
  // The chrome's two ends, which are the palette's own unless a theme has said
  // otherwise. Note that `--bg-0` is still exactly `ground`, so a terminal sits
  // on the same colour its pane is painted in and there is no seam at the edge.
  const ground = rgb(theme.chrome?.bg ?? p.bg);
  const ink = rgb(theme.chrome?.fg ?? p.fg);
  const accent = theme.accent ?? p.cursor;
  const dark = theme.base === "dark";

  // Black or white, whichever the accent is further from. Not an end of this
  // theme's own range: an accent and a background can be the same lightness in
  // different hues — which is a perfectly good accent and unreadable text.
  const brandForeground = lightness(rgb(accent)) > 0.5 ? "#000000" : "#ffffff";

  const vars: Record<string, string> = {
    "--bg-0": hslTriple(mix(ground, ink, SURFACE[0])),
    "--bg-1": hslTriple(mix(ground, ink, SURFACE[1])),
    "--bg-2": hslTriple(mix(ground, ink, SURFACE[2])),
    "--bg-3": hslTriple(mix(ground, ink, SURFACE[3])),

    "--border-1": hslTriple(mix(ground, ink, HAIRLINE[0])),
    "--border-2": hslTriple(mix(ground, ink, HAIRLINE[1])),

    "--text-1": hslTriple(mix(ink, ground, INK[0])),
    "--text-2": hslTriple(mix(ink, ground, INK[1])),
    "--text-3": hslTriple(mix(ink, ground, INK[2])),
    "--text-4": hslTriple(mix(ink, ground, INK[3])),

    "--brand": hslTriple(rgb(accent)),
    "--brand-foreground": hslTriple(rgb(brandForeground)),
    // The bright slots on a dark theme, the ordinary ones on a light theme —
    // in both cases the version of that hue meant to be read against the page.
    "--warn": hslTriple(rgb(dark ? p.brightYellow : p.yellow)),
    "--danger": hslTriple(rgb(dark ? p.brightRed : p.red)),

    // The terminal's own background is the one token that may carry alpha, so
    // that an ambient drawing shows through the text. `--term-bg-solid` is the
    // same colour with none, for the places that need something to sit on —
    // the cursor's own text, and the first paint before any canvas exists.
    "--term-bg": theme.ambient ? withAlpha(p.bg, theme.veil ?? 0.75) : p.bg,
    "--term-bg-solid": p.bg,
    "--term-fg": p.fg,
    "--term-cursor": p.cursor,
    // Derived rather than authored: a selection is the cursor colour laid over
    // the text at a weight that keeps the text readable, in every theme.
    "--term-selection": `rgba(${rgb(p.cursor).map(Math.round).join(", ")}, 0.26)`,

    "--term-black": p.black,
    "--term-red": p.red,
    "--term-green": p.green,
    "--term-yellow": p.yellow,
    "--term-blue": p.blue,
    "--term-magenta": p.magenta,
    "--term-cyan": p.cyan,
    "--term-white": p.white,
    "--term-bright-black": p.brightBlack,
    "--term-bright-red": p.brightRed,
    "--term-bright-green": p.brightGreen,
    "--term-bright-yellow": p.brightYellow,
    "--term-bright-blue": p.brightBlue,
    "--term-bright-magenta": p.brightMagenta,
    "--term-bright-cyan": p.brightCyan,
    "--term-bright-white": p.brightWhite,
  };

  return vars;
}

/** The colours a menu row shows to say what a theme looks like, in order. */
export function swatch(theme: Theme): string[] {
  const p = theme.palette;
  return [p.bg, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.fg];
}

/* ── The themes ──────────────────────────────────────────────────────────── */

/**
 * `system` is not in here. It is a *choice*, not a theme — it resolves to one
 * of the two below depending on the desktop, and `lib/appearance.ts` is what
 * does the resolving.
 */
export const THEMES: Theme[] = [
  /* ── Foundations ─────────────────────────────────────────────────────── */
  {
    id: "dark",
    name: "Midnight",
    group: "Foundations",
    base: "dark",
    palette: {
      bg: "#000000",
      fg: "#ededed",
      cursor: "#f2cd6b",
      black: "#1c1c1c",
      red: "#e35a5a",
      green: "#8bbf7a",
      yellow: "#e0b155",
      blue: "#6c9bd1",
      magenta: "#b98cc7",
      cyan: "#6fb3ae",
      white: "#b8b8b8",
      brightBlack: "#545454",
      brightRed: "#ff7a7a",
      brightGreen: "#a8dc96",
      brightYellow: "#f2cd6b",
      brightBlue: "#8bb8ea",
      brightMagenta: "#d3a8e0",
      brightCyan: "#8fd2cc",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "light",
    name: "Paper",
    group: "Foundations",
    base: "light",
    palette: {
      bg: "#ffffff",
      fg: "#1a1a1c",
      cursor: "#a8760a",
      black: "#2b2b2f",
      red: "#c0392b",
      green: "#3f7a35",
      yellow: "#96690c",
      blue: "#2f5fa8",
      magenta: "#7d4a94",
      cyan: "#2b7772",
      white: "#8b8b90",
      brightBlack: "#5c5c62",
      brightRed: "#d8503f",
      brightGreen: "#4d9440",
      brightYellow: "#b07f12",
      brightBlue: "#3d75c4",
      brightMagenta: "#945bad",
      brightCyan: "#349089",
      brightWhite: "#1a1a1c",
    },
  },

  /* ── Palettes ────────────────────────────────────────────────────────── */
  {
    id: "gruvbox",
    name: "Gruvbox",
    group: "Palettes",
    base: "dark",
    palette: {
      bg: "#1d2021",
      fg: "#ebdbb2",
      cursor: "#fabd2f",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    group: "Palettes",
    base: "dark",
    accent: "#bd93f9",
    palette: {
      bg: "#282a36",
      fg: "#f8f8f2",
      cursor: "#ff79c6",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    group: "Palettes",
    base: "dark",
    palette: {
      bg: "#2e3440",
      fg: "#d8dee9",
      cursor: "#88c0d0",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#d08770",
      brightGreen: "#b5d0a0",
      brightYellow: "#f0d8a0",
      brightBlue: "#95b4d4",
      brightMagenta: "#c8a2c0",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    group: "Palettes",
    base: "dark",
    accent: "#a6e22e",
    palette: {
      bg: "#272822",
      fg: "#f8f8f2",
      cursor: "#f8f8f0",
      black: "#3e3d32",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#f4bf75",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
      brightBlack: "#75715e",
      brightRed: "#fd5f95",
      brightGreen: "#bcf04a",
      brightYellow: "#ffd68a",
      brightBlue: "#8ee4f5",
      brightMagenta: "#c8a2ff",
      brightCyan: "#b8f5ec",
      brightWhite: "#f9f8f5",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    group: "Palettes",
    base: "dark",
    accent: "#7aa2f7",
    palette: {
      bg: "#1a1b26",
      fg: "#c0caf5",
      cursor: "#7aa2f7",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#ff7a93",
      brightGreen: "#b9f27c",
      brightYellow: "#ff9e64",
      brightBlue: "#9db5ff",
      brightMagenta: "#d2b0ff",
      brightCyan: "#0db9d7",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    group: "Palettes",
    base: "dark",
    accent: "#cba6f7",
    palette: {
      bg: "#1e1e2e",
      fg: "#cdd6f4",
      cursor: "#f5e0dc",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f7a3bb",
      brightGreen: "#b8ecb4",
      brightYellow: "#fbebc4",
      brightBlue: "#a3c4fb",
      brightMagenta: "#f8d4ee",
      brightCyan: "#aae9df",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    group: "Palettes",
    base: "light",
    accent: "#8839ef",
    palette: {
      bg: "#eff1f5",
      fg: "#4c4f69",
      cursor: "#dc8a78",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#de293e",
      brightGreen: "#49af3d",
      brightYellow: "#eea847",
      brightBlue: "#456eff",
      brightMagenta: "#fe85d8",
      brightCyan: "#2d9fa8",
      brightWhite: "#bcc0cc",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    group: "Palettes",
    base: "dark",
    accent: "#b58900",
    palette: {
      bg: "#002b36",
      fg: "#93a1a1",
      cursor: "#b58900",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#657b83",
      brightYellow: "#839496",
      brightBlue: "#93a1a1",
      brightMagenta: "#6c71c4",
      brightCyan: "#a1b5b5",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    group: "Palettes",
    base: "light",
    accent: "#b58900",
    palette: {
      bg: "#fdf6e3",
      fg: "#586e75",
      cursor: "#b58900",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#93a1a1",
      brightBlack: "#657b83",
      brightRed: "#cb4b16",
      brightGreen: "#93a1a1",
      brightYellow: "#839496",
      brightBlue: "#3f8fd0",
      brightMagenta: "#6c71c4",
      brightCyan: "#35b3a9",
      brightWhite: "#002b36",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    group: "Palettes",
    base: "dark",
    accent: "#c4a7e7",
    palette: {
      bg: "#191724",
      fg: "#e0def4",
      cursor: "#ebbcba",
      black: "#26233a",
      red: "#eb6f92",
      green: "#31748f",
      yellow: "#f6c177",
      blue: "#9ccfd8",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
      brightRed: "#f08fab",
      brightGreen: "#4590ae",
      brightYellow: "#f9d39a",
      brightBlue: "#b3dce3",
      brightMagenta: "#d4bff0",
      brightCyan: "#f2cfce",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "everforest",
    name: "Everforest",
    group: "Palettes",
    base: "dark",
    accent: "#a7c080",
    palette: {
      bg: "#2d353b",
      fg: "#d3c6aa",
      cursor: "#a7c080",
      black: "#475258",
      red: "#e67e80",
      green: "#a7c080",
      yellow: "#dbbc7f",
      blue: "#7fbbb3",
      magenta: "#d699b6",
      cyan: "#83c092",
      white: "#d3c6aa",
      brightBlack: "#5d6b66",
      brightRed: "#ef9a9c",
      brightGreen: "#bcd39c",
      brightYellow: "#e8d0a0",
      brightBlue: "#9dcec7",
      brightMagenta: "#e4b3c8",
      brightCyan: "#9fd3ac",
      brightWhite: "#fffbef",
    },
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    group: "Palettes",
    base: "dark",
    accent: "#7e9cd8",
    palette: {
      bg: "#1f1f28",
      fg: "#dcd7ba",
      cursor: "#c8c093",
      black: "#16161d",
      red: "#c34043",
      green: "#76946a",
      yellow: "#c0a36e",
      blue: "#7e9cd8",
      magenta: "#957fb8",
      cyan: "#6a9589",
      white: "#c8c093",
      brightBlack: "#727169",
      brightRed: "#e82424",
      brightGreen: "#98bb6c",
      brightYellow: "#e6c384",
      brightBlue: "#7fb4ca",
      brightMagenta: "#938aa9",
      brightCyan: "#7aa89f",
      brightWhite: "#dcd7ba",
    },
  },

  /* ── Character ───────────────────────────────────────────────────────── */
  {
    id: "synthwave",
    name: "Synthwave '84",
    group: "Character",
    base: "dark",
    accent: "#ff7edb",
    palette: {
      bg: "#262335",
      fg: "#f8f8f2",
      cursor: "#ff7edb",
      black: "#241b2f",
      red: "#fe4450",
      green: "#72f1b8",
      yellow: "#fede5d",
      blue: "#2ee2fa",
      magenta: "#ff7edb",
      cyan: "#03edf9",
      white: "#f8f8f2",
      brightBlack: "#495495",
      brightRed: "#ff6d77",
      brightGreen: "#95f7cc",
      brightYellow: "#ffea8a",
      brightBlue: "#66ecff",
      brightMagenta: "#ffa1e6",
      brightCyan: "#7bf4fb",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "phosphor",
    name: "Phosphor",
    group: "Character",
    base: "dark",
    accent: "#33ff33",
    palette: {
      bg: "#0a1109",
      fg: "#33ff33",
      cursor: "#7fff7f",
      black: "#123312",
      red: "#2fdd2f",
      green: "#33ff33",
      yellow: "#66ff66",
      blue: "#1fbb1f",
      magenta: "#55ee55",
      cyan: "#44ff88",
      white: "#a8ffa8",
      brightBlack: "#1f5a1f",
      brightRed: "#66ff66",
      brightGreen: "#7dff7d",
      brightYellow: "#99ff99",
      brightBlue: "#4de84d",
      brightMagenta: "#8cff8c",
      brightCyan: "#7dffb0",
      brightWhite: "#ddffdd",
    },
  },
  {
    id: "amber",
    name: "Amber CRT",
    group: "Character",
    base: "dark",
    accent: "#ffb000",
    palette: {
      bg: "#140d02",
      fg: "#ffb000",
      cursor: "#ffcc44",
      black: "#33230a",
      red: "#ff8c1a",
      green: "#ffb000",
      yellow: "#ffc233",
      blue: "#cc8800",
      magenta: "#ffa033",
      cyan: "#ffd166",
      white: "#ffdca8",
      brightBlack: "#5c400f",
      brightRed: "#ffa347",
      brightGreen: "#ffc75c",
      brightYellow: "#ffd980",
      brightBlue: "#e6a012",
      brightMagenta: "#ffb85c",
      brightCyan: "#ffe199",
      brightWhite: "#fff2d1",
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    group: "Character",
    base: "dark",
    accent: "#a8cbff",
    palette: {
      bg: "#10365c",
      fg: "#e8f2ff",
      cursor: "#ffffff",
      black: "#1c4c78",
      red: "#ffb3b3",
      green: "#b9e6c8",
      yellow: "#ffe9a8",
      blue: "#a8cbff",
      magenta: "#dcc3ff",
      cyan: "#b2ecf2",
      white: "#e8f2ff",
      brightBlack: "#2f6396",
      brightRed: "#ffd0d0",
      brightGreen: "#d5f3de",
      brightYellow: "#fff3cc",
      brightBlue: "#cde2ff",
      brightMagenta: "#ecdcff",
      brightCyan: "#d6f7fa",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "parchment",
    name: "Parchment",
    group: "Character",
    base: "light",
    accent: "#a0522d",
    palette: {
      bg: "#f4ecd8",
      fg: "#3b3227",
      cursor: "#a0522d",
      black: "#5b5041",
      red: "#a03e2f",
      green: "#55702f",
      yellow: "#97701a",
      blue: "#3a5f8a",
      magenta: "#7a4a78",
      cyan: "#2f6f6a",
      white: "#8a7f6c",
      brightBlack: "#6f6353",
      brightRed: "#c2543f",
      brightGreen: "#6d8b3d",
      brightYellow: "#b08a24",
      brightBlue: "#4d78ab",
      brightMagenta: "#96609a",
      brightCyan: "#3f8d86",
      brightWhite: "#3b3227",
    },
  },
  {
    // Windows 3.1's, faithfully. It is a joke, and it is also a real
    // high-contrast scheme that some people genuinely prefer.
    id: "hotdog",
    name: "Hotdog Stand",
    group: "Character",
    base: "dark",
    accent: "#ffff00",
    // Red and yellow are both exactly 50% light, so the chrome is ramped
    // towards white instead — which is also what Windows 3.1 actually drew its
    // title bars in. The terminal keeps the yellow; that is where the joke is.
    chrome: { fg: "#ffffff" },
    palette: {
      bg: "#ff0000",
      fg: "#ffff00",
      cursor: "#ffffff",
      black: "#000000",
      red: "#ffffff",
      green: "#ffff00",
      yellow: "#ffff88",
      blue: "#000000",
      magenta: "#ffffff",
      cyan: "#ffff00",
      white: "#ffffff",
      brightBlack: "#440000",
      brightRed: "#ffffff",
      brightGreen: "#ffffaa",
      brightYellow: "#ffffcc",
      brightBlue: "#330000",
      brightMagenta: "#ffffff",
      brightCyan: "#ffffcc",
      brightWhite: "#ffffff",
    },
  },

  /* ── Living ──────────────────────────────────────────────────────────── */
  {
    id: "mandelbrot",
    name: "Mandelbrot Drift",
    group: "Living",
    base: "dark",
    ambient: "mandelbrot",
    veil: 0.78,
    accent: "#c792ea",
    palette: {
      bg: "#08060f",
      fg: "#ded6ff",
      cursor: "#a78bfa",
      black: "#221b3a",
      red: "#ff6b8a",
      green: "#7ee0b8",
      yellow: "#f0c674",
      blue: "#7aa2ff",
      magenta: "#c792ea",
      cyan: "#74d7ec",
      white: "#cfc7ea",
      brightBlack: "#4a3f72",
      brightRed: "#ff92a8",
      brightGreen: "#a6f0d0",
      brightYellow: "#ffdf9a",
      brightBlue: "#a3c0ff",
      brightMagenta: "#dcb4ff",
      brightCyan: "#9ce8f7",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "julia",
    name: "Julia Bloom",
    group: "Living",
    base: "dark",
    ambient: "julia",
    veil: 0.78,
    accent: "#5eead4",
    palette: {
      bg: "#05100f",
      fg: "#d6f2ec",
      cursor: "#5eead4",
      black: "#123632",
      red: "#ff7a8a",
      green: "#5eead4",
      yellow: "#fcd34d",
      blue: "#67b8ff",
      magenta: "#f0abfc",
      cyan: "#67e8f9",
      white: "#b8ded6",
      brightBlack: "#2c5d56",
      brightRed: "#ffa0ab",
      brightGreen: "#99f6e4",
      brightYellow: "#fde68a",
      brightBlue: "#93cbff",
      brightMagenta: "#f5c2fd",
      brightCyan: "#a5f3fc",
      brightWhite: "#f0fdfa",
    },
  },
  {
    id: "nebula",
    name: "Nebula",
    group: "Living",
    base: "dark",
    ambient: "nebula",
    veil: 0.74,
    accent: "#ff9de2",
    palette: {
      bg: "#070512",
      fg: "#e6e1ff",
      cursor: "#ff9de2",
      black: "#221d3d",
      red: "#ff7597",
      green: "#8de6b0",
      yellow: "#ffd88a",
      blue: "#8ab4ff",
      magenta: "#ff9de2",
      cyan: "#7fe6e6",
      white: "#cec8e8",
      brightBlack: "#463c72",
      brightRed: "#ff9db3",
      brightGreen: "#b0f0c9",
      brightYellow: "#ffe7b3",
      brightBlue: "#b0cdff",
      brightMagenta: "#ffbbec",
      brightCyan: "#a6f0f0",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    group: "Living",
    base: "dark",
    ambient: "aurora",
    veil: 0.76,
    accent: "#7ef0c8",
    palette: {
      bg: "#04101a",
      fg: "#d8ecf5",
      cursor: "#7ef0c8",
      black: "#123244",
      red: "#ff8a8a",
      green: "#7ef0c8",
      yellow: "#ffe08a",
      blue: "#7fc4ff",
      magenta: "#c6a6ff",
      cyan: "#7fe8f0",
      white: "#bcd6e2",
      brightBlack: "#2b5670",
      brightRed: "#ffa8a8",
      brightGreen: "#a8f7db",
      brightYellow: "#ffedb3",
      brightBlue: "#a8d8ff",
      brightMagenta: "#dcc6ff",
      brightCyan: "#a8f2f7",
      brightWhite: "#f0fbff",
    },
  },
  {
    id: "digital-rain",
    name: "Digital Rain",
    group: "Living",
    base: "dark",
    ambient: "rain",
    veil: 0.7,
    accent: "#35f56f",
    palette: {
      bg: "#020604",
      fg: "#9dffb0",
      cursor: "#b8ffc8",
      black: "#0f2b18",
      red: "#4bff9b",
      green: "#35f56f",
      yellow: "#86ff9e",
      blue: "#22c463",
      magenta: "#62ff8f",
      cyan: "#4dffc2",
      white: "#b6ffc6",
      brightBlack: "#1d5c30",
      brightRed: "#7dffbe",
      brightGreen: "#7bffa0",
      brightYellow: "#b0ffc0",
      brightBlue: "#43e585",
      brightMagenta: "#9bffb8",
      brightCyan: "#8affd8",
      brightWhite: "#e6fff0",
    },
  },
  {
    id: "warp",
    name: "Warp",
    group: "Living",
    base: "dark",
    ambient: "warp",
    veil: 0.72,
    accent: "#9ec5ff",
    palette: {
      bg: "#01030a",
      fg: "#dce6ff",
      cursor: "#9ec5ff",
      black: "#16203a",
      red: "#ff7b8f",
      green: "#86e6b4",
      yellow: "#ffd98f",
      blue: "#7fb0ff",
      magenta: "#c39cff",
      cyan: "#86dcf5",
      white: "#c3cfe6",
      brightBlack: "#35456e",
      brightRed: "#ffa2b0",
      brightGreen: "#aef2d0",
      brightYellow: "#ffe9b8",
      brightBlue: "#a9caff",
      brightMagenta: "#dcc0ff",
      brightCyan: "#aeeaf9",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "lava",
    name: "Lava Lamp",
    group: "Living",
    base: "dark",
    ambient: "lava",
    veil: 0.74,
    accent: "#ff8c42",
    palette: {
      bg: "#12060a",
      fg: "#ffe3d1",
      cursor: "#ff8c42",
      black: "#3b1a1a",
      red: "#ff5c5c",
      green: "#d2c04a",
      yellow: "#ffb03a",
      blue: "#ff7a45",
      magenta: "#ff6f9c",
      cyan: "#ffcf6b",
      white: "#f0cbb4",
      brightBlack: "#6b2d28",
      brightRed: "#ff8080",
      brightGreen: "#ecd96a",
      brightYellow: "#ffc768",
      brightBlue: "#ff9a6e",
      brightMagenta: "#ff96b8",
      brightCyan: "#ffe0a0",
      brightWhite: "#fff3e8",
    },
  },
];

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

/** Every group, in the order the menu should show them. */
export const THEME_GROUPS: string[] = THEMES.reduce<string[]>((groups, theme) => {
  if (!groups.includes(theme.group)) groups.push(theme.group);
  return groups;
}, []);

export function themeById(id: string): Theme | null {
  return BY_ID.get(id) ?? null;
}

/** `system` included, since it is a thing a settings file may legally say. */
export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && (value === "system" || BY_ID.has(value));
}

/** What to call a choice in the interface — the one place `system` has a name. */
export function themeName(id: string): string {
  return id === "system" ? "System" : (BY_ID.get(id)?.name ?? id);
}

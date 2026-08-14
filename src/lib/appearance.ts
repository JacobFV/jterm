/**
 * Settings that are nothing but a change of paint, pushed onto the document.
 *
 * Everything here works by moving a CSS custom property rather than by handing
 * a value to a component. That is deliberate: the terminal builds its palette
 * by *reading* those properties (see `readTheme` in `TerminalPane`), so the
 * shell chrome and the shell contents cannot drift apart — there is one place a
 * colour is written down and both sides read it.
 *
 * It is also what lets a theme be chosen at three depths. The app's choice, a
 * tab's, a pane's: each narrows the last, and because custom properties inherit
 * they need no arbitration — the same tokens are written on the root for the
 * first two and on a pane's own box for the third, and every colour in the
 * subtree below simply resolves to the nearest one. `resolveTheme` decides what
 * a choice means; `themeStyle` addresses it at a box.
 *
 * Type sizes work the same way. Every size in the chrome is a fraction of
 * `--ui-font-size`, computed from it rather than nested inside it, so nothing
 * compounds: a label inside a labelled row is 11px because it asked for 11px,
 * not because it inherited 88% of something that had already shrunk.
 */

import { type Theme, themeById, themeVars } from "@/lib/themes";
import type { Settings, ThemeChoice } from "@/state/settings";

const SYSTEM_LIGHT = "(prefers-color-scheme: light)";

function systemQuery(): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(SYSTEM_LIGHT);
}

/**
 * The theme a choice actually means.
 *
 * `system` is the only choice that is not itself a theme; it stands for one of
 * the two foundations depending on the desktop. Anything else names a theme
 * directly, and a name with nothing behind it falls back rather than leaving
 * the app with no colours at all.
 */
export function resolveTheme(choice: ThemeChoice): Theme {
  if (choice === "system") {
    return themeById(systemQuery()?.matches ? "light" : "dark")!;
  }
  return themeById(choice) ?? themeById("dark")!;
}

/**
 * A font family as CSS will accept it, with the built-in stack behind it.
 *
 * People type `Fira Code`, not `"Fira Code", monospace`. A name with spaces has
 * to be quoted to be a valid family, and whatever they name has to fall back to
 * something that certainly exists — a typo should cost the font, not the glyphs.
 */
function monoStack(family: string): string {
  const wanted = family.trim();
  if (!wanted) return "var(--font-mono-default)";
  // A comma means they wrote a stack of their own and know the syntax.
  const quoted =
    wanted.includes(",") || wanted.includes('"') || wanted.includes("'")
      ? wanted
      : `"${wanted}"`;
  return `${quoted}, var(--font-mono-default)`;
}

/** The size scale, as multiples of the interface size. */
const SCALE: Record<string, number> = {
  "--fs-9": 0.72,
  "--fs-10": 0.8,
  "--fs-105": 0.84,
  "--fs-11": 0.88,
  "--fs-12": 0.96,
  "--fs-125": 1,
  "--fs-13": 1.04,
};

let latest: Settings | null = null;

/**
 * The active tab's theme, when it has one of its own.
 *
 * A theme is chosen at three levels — the app's, a tab's, a pane's — and each
 * one narrows the last. This is the middle level, held here rather than passed
 * in because the caller of `applyAppearance` is the settings store, which knows
 * nothing about tabs. `App` pushes the active tab's choice in as the tab
 * changes, and the two meet at `windowTheme` below.
 *
 * The pane level is not here at all: it is written onto the pane's own box by
 * `Workspace`, where it can differ from its neighbour's.
 */
let tabChoice: ThemeChoice | undefined;

/** The choice in force for the window's chrome: the tab's, else the app's. */
function windowTheme(settings: Settings): ThemeChoice {
  return tabChoice ?? settings.theme;
}

/**
 * Say which theme the tab now on screen is wearing, or `undefined` for one that
 * simply follows the app. Repaints the chrome, since that is what switching to
 * a tab with a theme of its own is *for*.
 */
export function setTabTheme(choice: ThemeChoice | undefined): void {
  if (choice === tabChoice) return;
  tabChoice = choice;
  if (latest !== null) applyAppearance(latest);
}

/**
 * Every colour token of a theme, as a style object for one box.
 *
 * The same values `applyAppearance` writes onto the root, addressed at a
 * subtree instead — which is the whole of how a pane wears a theme its tab does
 * not. A pane writes its own set unconditionally rather than only where it
 * disagrees with the root, so that its colours are settled by the commit that
 * lays it out and never by *when* some ancestor's effect happened to run.
 *
 * Cached because `Workspace` re-renders on every layout change and there are
 * only ever a handful of distinct answers. React is also handed the same object
 * identity each time, so an unchanged theme is not a style write at all. The
 * map is unbounded but cannot grow far: one entry per theme actually in use per
 * stop on the presence slider, which is a slider with thirty-three stops.
 */
const styles = new Map<string, Record<string, string>>();

export function themeStyle(choice: ThemeChoice, presence: number): Record<string, string> {
  const key = `${choice}|${presence}`;
  const known = styles.get(key);
  if (known) return known;
  const theme = resolveTheme(choice);
  const made = { ...themeVars(theme, presence), colorScheme: theme.base };
  styles.set(key, made);
  return made;
}

/* ── The desktop's own light/dark preference ─────────────────────────────── */

const schemeWatchers = new Set<() => void>();

/**
 * Which of the two foundations `system` currently means.
 *
 * Exposed as a value so React can hold it: the tokens a pane wears are computed
 * during render, and a render only happens if something React knows about has
 * moved. Before themes could be chosen per pane the desktop flipping was
 * entirely a matter for the root — one rewrite here and the whole window
 * followed — but a `system` chosen for one pane lives in that pane's own style
 * attribute, and nothing would put it back without a re-render.
 */
export function systemScheme(): "dark" | "light" {
  return systemQuery()?.matches ? "light" : "dark";
}

export function subscribeSystemScheme(listener: () => void): () => void {
  watchSystem();
  schemeWatchers.add(listener);
  return () => {
    schemeWatchers.delete(listener);
  };
}

let watchingSystem = false;

/**
 * Attach the desktop listener, once.
 *
 * Called from `applyAppearance` and from the subscription above rather than at
 * import, so a module that only wants `resolveTheme` does not quietly start
 * listening to the desktop.
 */
function watchSystem(): void {
  if (watchingSystem) return;
  const query = systemQuery();
  if (query === null) return;
  watchingSystem = true;
  query.addEventListener("change", () => {
    // `system` is the one choice whose colours are not a function of the choice
    // alone, so a flip invalidates everything computed under it. The repaint is
    // unconditional because any of the three levels may have chosen it, and
    // this side of the app cannot see two of them.
    styles.clear();
    if (latest !== null) applyAppearance(latest);
    for (const watcher of schemeWatchers) watcher();
  });
}

export function applyAppearance(settings: Settings): void {
  latest = settings;
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const theme = resolveTheme(windowTheme(settings));

  // Every colour token, written as an inline style. That beats the `:root`
  // blocks in `index.css` — which stay behind only as the palette of the very
  // first paint, before the settings file has been read — so a theme is data
  // here rather than a stylesheet that would have to be edited to add one.
  for (const [name, value] of Object.entries(themeVars(theme, settings.ambientPresence))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.base;
  root.style.colorScheme = theme.base;
  // Whether a backdrop is drawn here, and therefore whether the surfaces that
  // would cover it stand down, is `--ground` — written by `themeVars` above
  // along with the colours, so a pane wearing a different theme gets its own
  // answer rather than the root's. See `.pane-ground` in `index.css`.

  root.style.setProperty("--ui-font-size", `${settings.uiFontSize}px`);
  for (const [name, factor] of Object.entries(SCALE)) {
    root.style.setProperty(name, `${(settings.uiFontSize * factor).toFixed(3)}px`);
  }

  root.style.setProperty("--font-mono", monoStack(settings.fontFamily));
  // The size monospaced *content* is drawn at, as opposed to the chrome's
  // scale above. xterm is configured with the number directly — it measures a
  // cell rather than laying out CSS — but the text pane reads this, so the two
  // are the same size for the same reason they are the same colour: one place
  // it is written down, and zoom moves that one place.
  root.style.setProperty("--mono-font-size", `${settings.fontSize}px`);

  watchSystem();
}

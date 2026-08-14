/**
 * Settings that are nothing but a change of paint, pushed onto the document.
 *
 * Everything here works by moving a CSS custom property rather than by handing
 * a value to a component. That is deliberate: the terminal builds its palette
 * by *reading* those properties (see `readTheme` in `TerminalPane`), so the
 * shell chrome and the shell contents cannot drift apart — there is one place a
 * colour is written down and both sides read it.
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
let watchingSystem = false;

export function applyAppearance(settings: Settings): void {
  latest = settings;
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const theme = resolveTheme(settings.theme);

  // Every colour token, written as an inline style. That beats the `:root`
  // blocks in `index.css` — which stay behind only as the palette of the very
  // first paint, before the settings file has been read — so a theme is data
  // here rather than a stylesheet that would have to be edited to add one.
  for (const [name, value] of Object.entries(themeVars(theme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.base;
  root.style.colorScheme = theme.base;

  // The two things a theme can ask the layout for, rather than the palette:
  // that a backdrop is drawn behind the panes, and — as a consequence — that
  // the surfaces which would cover it stand down. See `.pane-ground`.
  if (theme.ambient) root.dataset.ambient = theme.ambient;
  else delete root.dataset.ambient;

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

  // Attached on the first apply rather than at import, so a module that only
  // wants `resolveTheme` does not quietly start listening to the desktop.
  if (!watchingSystem) {
    const query = systemQuery();
    query?.addEventListener("change", () => {
      if (latest?.theme === "system") applyAppearance(latest);
    });
    watchingSystem = query !== null;
  }
}

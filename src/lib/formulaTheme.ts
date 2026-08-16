import type { Theme } from "./themes";

/**
 * Monochrome palette for @yuruyurau's point-formula backdrop.
 * `ambient` is set to an existing living id only so the standard theme plumbing
 * makes panes translucent; AmbientBackdrop routes this theme to its own exact
 * renderer by id.
 */
export const FORMULA_THEME: Theme = {
  id: "formula",
  name: "Formula",
  group: "Living",
  base: "dark",
  ambient: "lorenz",
  veil: 0.68,
  accent: "#ffffff",
  palette: {
    bg: "#090909",
    fg: "#ededed",
    cursor: "#ffffff",
    black: "#161616",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#c8c8c8",
    brightBlack: "#5c6370",
    brightRed: "#ff7a85",
    brightGreen: "#b4e38e",
    brightYellow: "#f3d38f",
    brightBlue: "#8bc8ff",
    brightMagenta: "#dc9bf2",
    brightCyan: "#7ad7e3",
    brightWhite: "#ffffff",
  },
};

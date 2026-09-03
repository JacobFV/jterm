import type { Theme } from "./themes";

/**
 * Palette for the 8-bit platformer backdrop. `ambient` names an existing
 * living id only so the standard theme plumbing makes panes translucent;
 * AmbientBackdrop routes this theme to its own renderer by id, the same way
 * the Formula theme does.
 */
export const MARIO_THEME: Theme = {
  id: "mario",
  name: "8-Bit Plumber",
  group: "Living",
  base: "dark",
  ambient: "lorenz",
  veil: 0.72,
  accent: "#e52521",
  palette: {
    bg: "#0b0f1e",
    fg: "#f0f0f0",
    cursor: "#e52521",
    black: "#12172c",
    red: "#e52521",
    green: "#00a800",
    yellow: "#fca800",
    blue: "#5c94fc",
    magenta: "#c86efc",
    cyan: "#00d8d8",
    white: "#f8b878",
    brightBlack: "#3a4468",
    brightRed: "#ff6b66",
    brightGreen: "#5cdc5c",
    brightYellow: "#ffd066",
    brightBlue: "#9cc4ff",
    brightMagenta: "#e0a8ff",
    brightCyan: "#66f0f0",
    brightWhite: "#fff2d1",
  },
};

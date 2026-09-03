/**
 * The living themes that don't fit `ambient.ts`'s painter table: each owns a
 * full scene rather than a cheap wash of colour, so each gets its own module.
 * Formula was the first of these; this file is what let the rest — a
 * side-scroller, a snake, a shooter, a falling-block game — join it without
 * every one of them touching `AmbientBackdrop`, `appearance.ts` and
 * `ThemeMenu` by hand. Add a game by writing its theme and its renderer, then
 * adding one line here.
 */

import type { AmbientTuning } from "./ambient";
import { startFormulaAmbient } from "./formulaAmbient";
import { FORMULA_THEME } from "./formulaTheme";
import { startInvadersAmbient } from "./invadersAmbient";
import { INVADERS_THEME } from "./invadersTheme";
import { startMarioAmbient } from "./marioAmbient";
import { MARIO_THEME } from "./marioTheme";
import { startSnakeAmbient } from "./snakeAmbient";
import { SNAKE_THEME } from "./snakeTheme";
import { startTetrisAmbient } from "./tetrisAmbient";
import { TETRIS_THEME } from "./tetrisTheme";
import { isThemeId, type Palette, type Theme } from "./themes";

export interface CustomAmbient {
  theme: Theme;
  start: (canvas: HTMLCanvasElement, palette: Palette, tuning: () => AmbientTuning) => () => void;
}

export const CUSTOM_AMBIENTS: CustomAmbient[] = [
  { theme: FORMULA_THEME, start: startFormulaAmbient },
  { theme: MARIO_THEME, start: startMarioAmbient },
  { theme: SNAKE_THEME, start: startSnakeAmbient },
  { theme: INVADERS_THEME, start: startInvadersAmbient },
  { theme: TETRIS_THEME, start: startTetrisAmbient },
];

const BY_ID = new Map(CUSTOM_AMBIENTS.map((c) => [c.theme.id, c]));

export function customAmbientById(id: string): CustomAmbient | undefined {
  return BY_ID.get(id);
}

/**
 * `isThemeId`, widened to also recognise these. `lib/themes.ts` can't do
 * this itself — every one of these renderers is a heavier module than a
 * theme has any business dragging in, which is the whole reason they live
 * outside `THEMES` — so the settings and snapshot code that used to validate
 * a stored theme choice with `isThemeId` alone needs this instead, or a
 * saved "8-Bit Plumber" (or Formula, or any of the rest) quietly reverts to
 * the default on the next launch.
 */
export function isThemeChoice(value: unknown): value is string {
  return isThemeId(value) || (typeof value === "string" && BY_ID.has(value));
}

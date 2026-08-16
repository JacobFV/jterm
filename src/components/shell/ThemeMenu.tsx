/**
 * The theme list, as a menu — and as a preview.
 *
 * Pointing at a row *applies* that theme rather than describing it. A swatch
 * eight pixels wide cannot tell you what a palette is like to read code in, and
 * a settings page you have to travel to and back from cannot either; the only
 * honest preview of a terminal theme is the terminal, wearing it, with your own
 * work still on screen. So a hover commits and leaving the menu puts back
 * whatever you had — the row you actually clicked, or the theme you came in
 * with if you clicked nothing.
 *
 * This is the menu for the two *inner* levels, a tab's and a pane's. The app's
 * own theme is chosen in the Settings window, where the whole set is laid out
 * as a grid rather than a list. Which level a given menu is editing is entirely
 * the caller's business: this component is handed the choice in force, told
 * what deferring is called here, and reports back.
 */

import { useEffect, useRef } from "react";

import { FORMULA_THEME } from "@/lib/formulaTheme";
import { THEME_GROUPS, THEMES, themeById } from "@/lib/themes";
import type { ThemeChoice } from "@/state/settings";
import { MenuHeading, MenuItem } from "./Menu";
import { ThemeSwatch } from "./ThemeSwatch";

/**
 * Square, and big enough to be a picture.
 *
 * A living theme's swatch is its drawing actually running, and the old ribbon
 * — half as tall as it was wide — cropped every one of them to a stripe. Square
 * is the shape a spiral or a fractal survives being shrunk into.
 */
const SWATCH = "h-[18px] w-[18px]";

function Swatch({ themeId }: { themeId: string }) {
  const theme = themeId === FORMULA_THEME.id ? FORMULA_THEME : themeById(themeId);
  return <ThemeSwatch theme={theme} className={SWATCH} />;
}

interface ThemeMenuProps {
  /** The choice made at this level, or `undefined` where none has been. */
  value: ThemeChoice | undefined;
  /**
   * The first row: what declining to choose means here, and the theme that
   * currently answers for it. Every level has one — a pane falls back to its
   * tab, a tab to the app — and it is always the row at the top, so "put this
   * back" is in the same place wherever the menu was opened from.
   */
  defer: { label: string; resolves: ThemeChoice };
  /** `undefined` for the defer row. Called on hover as well as on click. */
  onChange: (choice: ThemeChoice | undefined) => void;
  onPick: () => void;
}

export function ThemeMenu({ value, defer, onChange, onPick }: ThemeMenuProps) {
  /**
   * What to go back to when the menu closes without a choice.
   *
   * Captured once, on the first render — after that `value` is whatever the
   * pointer is currently previewing, and reading it later would mean "go back
   * to the last thing you hovered", which is not going back.
   */
  const committed = useRef(value);
  const picked = useRef(false);
  // Read through a ref so the cleanup below can stay a mount-once effect: it
  // must run when the menu closes and at no other time, and `onChange` is a
  // fresh closure on every render of the menu's owner.
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(
    () => () => {
      if (!picked.current) changeRef.current(committed.current);
    },
    [],
  );

  const choose = (choice: ThemeChoice | undefined) => {
    picked.current = true;
    onChange(choice);
    onPick();
  };

  return (
    <>
      <MenuItem
        label={defer.label}
        adornment={<Swatch themeId={defer.resolves} />}
        selected={value === undefined}
        onHover={() => onChange(undefined)}
        onSelect={() => choose(undefined)}
      />
      {THEME_GROUPS.map((group) => {
        const themes =
          group === "Living"
            ? [...THEMES.filter((theme) => theme.group === group), FORMULA_THEME]
            : THEMES.filter((theme) => theme.group === group);
        return (
          <div key={group}>
            {/* Every group is ruled off, including the first — the row above it
                is the defer row, which belongs to no group. */}
            <MenuHeading divided>{group}</MenuHeading>
            {themes.map((theme) => (
              <MenuItem
                key={theme.id}
                label={theme.name}
                adornment={<Swatch themeId={theme.id} />}
                selected={value === theme.id}
                onHover={() => onChange(theme.id)}
                onSelect={() => choose(theme.id)}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

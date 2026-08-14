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
 * That does mean a hover writes the settings file. It is debounced upstream, so
 * running the pointer down the list costs one write when the pointer stops, and
 * the value written is one the user is looking at.
 */

import { useEffect, useRef } from "react";

import { useSettings } from "@/lib/useSettings";
import { THEME_GROUPS, THEMES, themeById } from "@/lib/themes";
import { updateSettings } from "@/state/settings";
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
  return <ThemeSwatch theme={themeById(themeId)} className={SWATCH} />;
}

export function ThemeMenu({ onPick }: { onPick: () => void }) {
  const settings = useSettings();
  const active = settings.theme;

  /**
   * What to go back to when the menu closes without a choice.
   *
   * Captured once, on the first render — after that `settings.theme` is
   * whatever the pointer is currently previewing, and reading it later would
   * mean "go back to the last thing you hovered", which is not going back.
   */
  const committed = useRef(active);
  const picked = useRef(false);

  useEffect(
    () => () => {
      if (!picked.current) updateSettings({ theme: committed.current });
    },
    [],
  );

  const rows = (group: string) =>
    THEMES.filter((theme) => theme.group === group).map((theme) => (
      <MenuItem
        key={theme.id}
        label={theme.name}
        adornment={<Swatch themeId={theme.id} />}
        selected={active === theme.id}
        onHover={() => updateSettings({ theme: theme.id })}
        onSelect={() => {
          picked.current = true;
          updateSettings({ theme: theme.id });
          onPick();
        }}
      />
    ));

  return (
    <>
      <MenuItem
        label="System"
        adornment={<Swatch themeId="system" />}
        selected={active === "system"}
        onHover={() => updateSettings({ theme: "system" })}
        onSelect={() => {
          picked.current = true;
          updateSettings({ theme: "system" });
          onPick();
        }}
      />
      {THEME_GROUPS.map((group) => (
        <div key={group}>
          {/* Every group is ruled off, including the first — the row above it
              is `System`, which belongs to no group. */}
          <MenuHeading divided>{group}</MenuHeading>
          {rows(group)}
        </div>
      ))}
    </>
  );
}

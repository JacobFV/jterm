import { describe, expect, it } from "vitest";

import { isThemeId, swatch, THEME_GROUPS, THEMES, themeById, themeName, themeVars } from "./themes";

/** `H S% L%` back into three numbers, so a token can be compared as colour. */
function hsl(triple: string): [number, number, number] {
  const parts = triple.split(/\s+/).map((part) => Number.parseFloat(part));
  expect(parts).toHaveLength(3);
  expect(parts.every((n) => Number.isFinite(n))).toBe(true);
  return [parts[0], parts[1], parts[2]];
}

const SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("the table", () => {
  it("has no two themes claiming the same id", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the ids an older settings file would name", () => {
    // The two jterm shipped with, before any of this existed. Renaming either
    // would silently reset the theme of everyone who had chosen it.
    expect(themeById("dark")?.name).toBe("Midnight");
    expect(themeById("light")?.name).toBe("Paper");
  });

  it("gives every theme a full palette of real colours", () => {
    for (const theme of THEMES) {
      for (const slot of [...SLOTS, "bg", "fg", "cursor"] as const) {
        expect(theme.palette[slot], `${theme.id}.${slot}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("puts every theme in a group the menu will show", () => {
    for (const theme of THEMES) expect(THEME_GROUPS).toContain(theme.group);
  });

  it("names `system`, which is a choice rather than a theme", () => {
    expect(isThemeId("system")).toBe(true);
    expect(themeById("system")).toBeNull();
    expect(themeName("system")).toBe("System");
  });

  it("rejects a theme that no longer exists", () => {
    expect(isThemeId("chartreuse")).toBe(false);
    expect(isThemeId(42)).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });
});

describe("themeVars", () => {
  it("writes every token the stylesheet and the terminal read", () => {
    // The full set, because a missing one does not fail loudly — it leaves the
    // first-paint value from `index.css` standing, so a theme would be applied
    // with one colour from a different theme and nothing would say so.
    const expected = [
      "--bg-0",
      "--bg-1",
      "--bg-2",
      "--bg-3",
      "--border-1",
      "--border-2",
      "--text-1",
      "--text-2",
      "--text-3",
      "--text-4",
      "--ground",
      "--brand",
      "--brand-foreground",
      "--warn",
      "--danger",
      "--term-bg",
      "--term-bg-solid",
      "--term-fg",
      "--term-cursor",
      "--term-selection",
      ...SLOTS.map((slot) => `--term-${slot.replace(/([A-Z])/g, "-$1").toLowerCase()}`),
    ];
    for (const theme of THEMES) {
      const vars = themeVars(theme);
      for (const name of expected) expect(Object.keys(vars), `${theme.id} ${name}`).toContain(name);
    }
  });

  it("still produces the palette jterm shipped with", () => {
    // Not exact: the values in `index.css` were picked by hand and the ramp
    // computes them. Close enough that the app looks the same is the claim.
    const vars = themeVars(themeById("dark")!);
    const near = (token: string, want: [number, number, number], slack: number) => {
      const got = hsl(vars[token]);
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i]), `${token}[${i}]`).toBeLessThanOrEqual(slack);
    };
    near("--bg-0", [0, 0, 0], 0.1);
    near("--bg-1", [0, 0, 2], 1);
    near("--bg-3", [0, 0, 6], 2.5);
    near("--text-1", [0, 0, 93], 0.5);
    near("--text-3", [0, 0, 42], 2);
    near("--brand", [45, 86, 69], 3);
  });

  it("keeps the ramps the right way round on a light theme", () => {
    // The same table produces both, so the one thing worth checking is that
    // nothing assumed dark: surfaces move away from the page and inks toward it.
    const vars = themeVars(themeById("light")!);
    const l = (token: string) => hsl(vars[token])[2];
    expect(l("--bg-0")).toBeGreaterThan(l("--bg-3"));
    expect(l("--border-1")).toBeGreaterThan(l("--border-2"));
    expect(l("--text-1")).toBeLessThan(l("--text-4"));
    expect(l("--text-4")).toBeLessThan(l("--bg-0"));
  });

  it("orders the surfaces and inks consistently in every theme", () => {
    for (const theme of THEMES) {
      const vars = themeVars(theme);
      const l = (token: string) => hsl(vars[token])[2];
      const away = theme.base === "dark" ? 1 : -1;
      // Each surface is further from the page's own ground than the last, and
      // each ink is nearer to it — in whichever direction this theme calls up.
      expect((l("--bg-3") - l("--bg-0")) * away, theme.id).toBeGreaterThan(0);
      expect((l("--border-2") - l("--border-1")) * away, theme.id).toBeGreaterThan(0);
      expect((l("--text-1") - l("--text-4")) * away, theme.id).toBeGreaterThan(0);
    }
  });

  it("makes the terminal translucent only where a backdrop is drawn", () => {
    for (const theme of THEMES) {
      const vars = themeVars(theme);
      expect(vars["--term-bg-solid"], theme.id).toBe(theme.palette.bg);
      if (theme.ambient) {
        // Eight digits: `#rrggbbaa`, which is the form xterm parses.
        expect(vars["--term-bg"], theme.id).toMatch(/^#[0-9a-f]{8}$/i);
        expect(vars["--term-bg"].slice(0, 7)).toBe(theme.palette.bg);
      } else {
        expect(vars["--term-bg"], theme.id).toBe(theme.palette.bg);
      }
    }
  });

  it("stands the ground down only where a backdrop is actually drawn", () => {
    // `--ground` is what a pane's own box paints itself in, and it has to say
    // "nothing at all" exactly when there is a drawing behind it — which is a
    // question about this theme *and* the presence slider, not about the root.
    for (const theme of THEMES) {
      const vars = themeVars(theme);
      // The surface it stands in for is `--bg-0`, written out rather than
      // referred to, so a box wearing this theme is painted correctly whatever
      // its ancestors did or did not declare.
      const opaque = `hsl(${vars["--bg-0"]})`;
      expect(vars["--ground"], theme.id).toBe(theme.ambient ? "transparent" : opaque);
      // Presence at zero is not a drawing you cannot see — it is no drawing,
      // and a transparent pane would then be showing the desktop.
      expect(themeVars(theme, 0)["--ground"], theme.id).toBe(opaque);
    }
  });

  it("gives the accent a foreground that is not the accent", () => {
    for (const theme of THEMES) {
      const vars = themeVars(theme);
      const brand = hsl(vars["--brand"]);
      const on = hsl(vars["--brand-foreground"]);
      // Lightness alone, since that is what carries legibility: text on a
      // filled accent has to be plainly darker or plainly lighter than it.
      expect(Math.abs(brand[2] - on[2]), theme.id).toBeGreaterThan(28);
    }
  });
});

describe("swatch", () => {
  it("leads with the background and follows with hues that differ from it", () => {
    for (const theme of THEMES) {
      const colors = swatch(theme);
      expect(colors[0], theme.id).toBe(theme.palette.bg);
      expect(colors.length).toBeGreaterThanOrEqual(6);
      // A swatch whose hues match its own background shows nothing at all.
      expect(colors.slice(1).every((c) => c !== colors[0]), theme.id).toBe(true);
    }
  });
});

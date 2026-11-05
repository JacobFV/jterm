import { ThemeSwatch } from "@/components/shell/ThemeSwatch";
import { THEME_GROUPS, THEMES } from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * Every theme, as a grid of the thing itself.
 *
 * A list of names would be useless here: nobody knows what "Kanagawa" looks
 * like, and the whole reason this window is a window is so a choice can be
 * seen. Each cell is a small terminal in that theme, typing — a prompt, a
 * `git status`, a test run — so the grid answers the question the names
 * cannot: what *your* terminal would look like. A living theme's cell is its
 * drawing instead, since the drawing is the thing being chosen.
 */
export function ThemePicker({
  value,
  onChange,
  groups = THEME_GROUPS,
}: {
  value: string;
  onChange: (id: string) => void;
  /** Which groups to show, after `system`. The welcome dialog leaves out the
   *  living themes: a first look at jterm is not the moment for all of them. */
  groups?: readonly string[];
}) {
  return (
    <div role="radiogroup" aria-label="Theme" className="space-y-3">
      {["", ...groups].map((group) => {
        // The empty group is `system`, which has no palette and so no cell of
        // its own kind; it gets the first row to itself.
        const items = group === "" ? [null] : THEMES.filter((theme) => theme.group === group);
        return (
          <div key={group || "system"}>
            {group ? (
              <div className="pane-title mb-1.5 text-[length:var(--fs-9)]">{group}</div>
            ) : null}
            <div className="grid grid-cols-3 gap-1.5">
              {items.map((theme) => {
                const id = theme?.id ?? "system";
                const active = value === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onChange(id)}
                    title={theme ? theme.name : "Follow the desktop"}
                    className={cn(
                      "flex flex-col gap-1 border p-1.5 text-left",
                      active ? "border-brand" : "border-hairline-strong hover:border-ink-4",
                    )}
                  >
                    {/* Near-square rather than the old short strip. A living
                        theme's cell is its drawing actually running, and a
                        letterboxed fractal is a texture, not a preview — a
                        Mandelbrot cropped to 3:1 is a stripe of edge detail
                        with the set itself off the top and bottom. */}
                    <ThemeSwatch
                      theme={theme}
                      className="aspect-[4/3] w-full border-0"
                      terminal
                    />
                    <span
                      className={cn(
                        "truncate text-[length:var(--fs-10)]",
                        active ? "text-brand" : "text-ink-2",
                      )}
                    >
                      {theme ? theme.name : "System"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The shortcut table, and the small ceremony of changing one.
 *
 * Rebinding is done by pressing the keys, not by typing their names: a chord is
 * easier to perform than to spell, and performing it is also the only way to
 * find out that your desktop has already taken it.
 *
 * Two rules are worth stating, because both are decisions rather than
 * accidents:
 *
 *   - **A chord belongs to one action.** Taking a chord that is already spoken
 *     for unbinds the previous holder rather than leaving two actions racing
 *     for the same key press, which `resolve` would settle by table order —
 *     that is, arbitrarily. The row that lost its binding says so.
 *   - **An override is only ever a difference.** A row left alone stores
 *     nothing, so if a default moves in a later version it moves for everyone
 *     who never touched it. Resetting a row deletes the entry rather than
 *     writing today's default into the file.
 */

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

import {
  BINDINGS,
  FIXED_BINDINGS,
  chordFromEvent,
  conflictingAction,
  defaultKeysFor,
  displayKeys,
  labelFor,
  type ActionGroup,
  type ActionId,
} from "@/lib/keymap";
import { cn } from "@/lib/utils";

type Overrides = Partial<Record<ActionId, string>>;

const GROUPS: ActionGroup[] = ["Tabs", "Panes", "View", "Window", "Terminal"];

export function KeyBindings({
  keys,
  onChange,
}: {
  keys: Overrides;
  onChange: (keys: Overrides) => void;
}) {
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (capturing === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Capture phase and unconditionally swallowed: the whole point is that
      // the keys being recorded do not also *do* anything, and `Mod+W` closing
      // the window mid-recording would be a memorable bug.
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        onChange({ ...keys, [capturing]: "" });
        setNote(`${labelFor(capturing)} has no shortcut now.`);
        setCapturing(null);
        return;
      }

      const chord = chordFromEvent(event);
      // A bare modifier: the user is still reaching for the rest of the chord.
      if (chord === null) return;

      const clash = conflictingAction(chord, capturing);
      const next: Overrides = { ...keys, [capturing]: chord };
      if (clash !== null) next[clash] = "";
      onChange(next);
      setNote(
        clash === null
          ? null
          : `${displayKeys(chord)} was ${labelFor(clash)} — that is unbound now.`,
      );
      setCapturing(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, keys, onChange]);

  const reset = (id: ActionId) => {
    const next = { ...keys };
    delete next[id];
    onChange(next);
    setNote(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-[length:var(--fs-105)] leading-relaxed text-ink-3">
        Click a shortcut and press the keys you want. <kbd className="font-mono">Esc</kbd> leaves
        it alone; <kbd className="font-mono">Backspace</kbd> removes it entirely.
      </p>

      {GROUPS.map((group) => {
        const rows = BINDINGS.filter((binding) => binding.group === group);
        const fixed = FIXED_BINDINGS.filter((binding) => binding.group === group);
        if (rows.length === 0 && fixed.length === 0) return null;

        return (
          <div key={group}>
            <h3 className="mb-1 font-mono text-[length:var(--fs-10)] uppercase tracking-[0.14em] text-ink-4">
              {group}
            </h3>
            <div className="border border-border">
              {rows.map((binding) => {
                const current = keys[binding.id] ?? defaultKeysFor(binding.id);
                const changed = keys[binding.id] !== undefined;
                const recording = capturing === binding.id;
                return (
                  <div
                    key={binding.id}
                    className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-[length:var(--fs-12)] text-ink-2">
                      {binding.label}
                    </span>

                    <button
                      type="button"
                      title={changed ? "Changed from the default" : "Click, then press the keys"}
                      onClick={() => {
                        setNote(null);
                        setCapturing(recording ? null : binding.id);
                      }}
                      className={cn(
                        "min-w-[110px] border px-2 py-0.5 text-center font-mono text-[length:var(--fs-11)]",
                        recording
                          ? "animate-pulse border-brand bg-brand/10 text-brand"
                          : current
                            ? "border-border bg-surface-1 text-ink-1 hover:border-hairline-strong"
                            : "border-border bg-surface-1 text-ink-4 hover:border-hairline-strong",
                      )}
                    >
                      {recording ? "Press keys…" : displayKeys(current)}
                    </button>

                    {/* Reserved even when empty, so the shortcut column does
                        not shift sideways as rows are changed and reset. */}
                    <span className="w-5 shrink-0">
                      {changed ? (
                        <button
                          type="button"
                          title="Back to the default"
                          aria-label={`Reset ${binding.label}`}
                          onClick={() => reset(binding.id)}
                          className="rounded-sm p-0.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}

              {fixed.map((binding) => (
                <div
                  key={binding.label}
                  className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0"
                  title="Built in — this one is a range of keys rather than a single chord"
                >
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-12)] text-ink-4">
                    {binding.label}
                  </span>
                  <span className="min-w-[110px] px-2 py-0.5 text-center font-mono text-[length:var(--fs-11)] text-ink-4">
                    {displayKeys(binding.keys)}
                  </span>
                  <span className="w-5 shrink-0" />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {note ? <p className="text-[length:var(--fs-105)] text-warn">{note}</p> : null}
    </div>
  );
}

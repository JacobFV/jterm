/**
 * The handful of controls the settings window is built from.
 *
 * Deliberately small and deliberately shared: the point of a settings page is
 * that the fifteenth row looks exactly like the first, so a row is a component
 * rather than a block of markup copied down the page. They follow the same
 * vocabulary as the rest of the app — hairlines instead of shadows, near-square
 * corners, one accent that means "this is the live value" and nothing else.
 *
 * Every control is uncontrolled about *when* it commits: they report on every
 * change rather than on blur, because the whole reason settings live in their
 * own window is to watch the main window react as you drag.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h2 className="pane-title mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * One setting: its name on the left, its control on the right.
 *
 * `hint` is for the thing the control cannot say itself — usually *when* a
 * change takes effect, which is the question a settings page most often leaves
 * unanswered.
 */
export function Row({
  label,
  hint,
  children,
  stacked = false,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  /** Put the control under the label, for anything too wide to sit beside it. */
  stacked?: boolean;
}) {
  return (
    <div className={cn("gap-3", stacked ? "block" : "flex items-baseline justify-between")}>
      <div className={cn("min-w-0", stacked ? "mb-1.5" : "flex-1")}>
        <div className="text-[length:var(--fs-125)] text-ink-1">{label}</div>
        {hint ? (
          <p className="mt-0.5 text-[length:var(--fs-105)] leading-relaxed text-ink-3">{hint}</p>
        ) : null}
      </div>
      <div className={cn("shrink-0", stacked && "w-full")}>{children}</div>
    </div>
  );
}

/**
 * A row of mutually exclusive choices, all visible at once.
 *
 * A dropdown for three options hides two of them behind a click for no gain;
 * with this the current choice and its alternatives are one glance.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex border border-border">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "border-r border-border px-2.5 py-1 text-[length:var(--fs-11)] last:border-r-0",
              active
                ? "bg-brand text-brand-foreground"
                : "bg-surface-1 text-ink-3 hover:bg-surface-2 hover:text-ink-1",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A number with a slider and its value in figures.
 *
 * Both, not either: the slider is how you find the size that looks right, and
 * the figure is how you tell someone else what you chose.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  label,
  format,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  format?: (value: number) => string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 w-[150px] cursor-pointer appearance-none bg-surface-3 accent-brand"
      />
      <span className="w-[52px] text-right font-mono text-[length:var(--fs-11)] text-ink-2">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => {
        const next = Number(event.target.value);
        // An empty field parses as 0, which is a real value here; anything
        // genuinely unreadable is ignored rather than written as NaN.
        if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
      }}
      className="w-[110px] border border-border bg-surface-1 px-2 py-1 text-right font-mono text-[length:var(--fs-11)] text-ink-1 focus:border-hairline-strong focus:outline-none"
    />
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <input
      type="text"
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="w-full border border-border bg-surface-1 px-2 py-1 font-mono text-[length:var(--fs-11)] text-ink-1 placeholder:text-ink-4 focus:border-hairline-strong focus:outline-none"
    />
  );
}

/** A switch, drawn as one rather than as a checkbox with a label beside it. */
export function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className={cn(
        "relative h-4 w-8 shrink-0 border transition-colors",
        value ? "border-brand bg-brand/30" : "border-border bg-surface-2",
      )}
    >
      <span
        className={cn(
          "absolute top-[1px] h-[12px] w-[12px] transition-all",
          value ? "left-[17px] bg-brand" : "left-[1px] bg-ink-4",
        )}
      />
    </button>
  );
}

export function Button({
  onClick,
  children,
  disabled = false,
  danger = false,
  className,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-2 border px-3 py-1.5 text-[length:var(--fs-12)] disabled:opacity-50",
        danger
          ? "border-border bg-surface-1 text-danger hover:border-danger hover:bg-surface-2"
          : "border-hairline-strong bg-surface-2 text-ink-1 hover:bg-surface-3",
        className,
      )}
    >
      {children}
    </button>
  );
}

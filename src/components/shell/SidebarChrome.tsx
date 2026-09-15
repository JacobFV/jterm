/**
 * The pieces every sidebar tab is framed with, so the four of them share one
 * header row: the switcher on the left, a title, and that tab's own buttons on
 * the right. Kept out of `Sidebar.tsx` so the tabs can use them without
 * importing the component that imports them.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function SidebarHeader({
  switcher,
  title,
  hint,
  children,
}: {
  switcher: ReactNode;
  title: ReactNode;
  /** The whole of what `title` abbreviates — a path, usually. */
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1.5">
      {switcher}
      <span
        className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-10)] text-ink-2"
        title={hint}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

export function HeaderButton({
  label,
  onClick,
  children,
  disabled = false,
  active = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** For a toggle that is on. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-sm p-1 hover:bg-surface-2 hover:text-ink-1 disabled:pointer-events-none disabled:opacity-40",
        active ? "text-brand" : "text-ink-4",
      )}
    >
      {children}
    </button>
  );
}

/** A quiet line of text in place of content: "reading…", "not a repository". */
export function SidebarNote({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "danger" }) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap break-words px-2 py-1 font-mono text-[length:var(--fs-10)]",
        tone === "danger" ? "text-danger" : "text-ink-4",
      )}
    >
      {children}
    </p>
  );
}

/** The last part of a path, for a title that has no room for the rest. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** An error as a person would want to read it. */
export function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "");
}

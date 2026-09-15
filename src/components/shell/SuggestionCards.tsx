/**
 * What a terminal pane is offering to do, drawn over its top-right corner.
 *
 * Over the terminal rather than in the pane header, because a tab with one pane
 * has no header, and the pane that just lost its shell is exactly the one being
 * looked at. Top-right because that is the part of a terminal least likely to
 * hold anything: output fills from the left, and a fresh prompt sits at the
 * bottom-left.
 *
 * Every card shows the command a button would type, in full. The whole promise
 * of offering rather than doing is that you can see what you are agreeing to.
 */

import { Lightbulb, X } from "lucide-react";

import type { Suggestion, SuggestionAction } from "@/lib/suggestions";
import { cn } from "@/lib/utils";

export function SuggestionCards({
  suggestions,
  onAction,
  onDismiss,
}: {
  suggestions: Suggestion[];
  onAction: (suggestion: Suggestion, action: SuggestionAction) => void;
  onDismiss: (id: string) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    // The column itself lets the pointer through, so the gap between cards is
    // still the terminal; only the cards take clicks.
    <div className="pointer-events-none absolute right-3 top-2 z-10 flex w-[min(340px,calc(100%-24px))] flex-col gap-2">
      {suggestions.map((suggestion) => {
        const command = suggestion.actions.find((action) => action.command)?.command;
        return (
          <div
            key={suggestion.id}
            role="status"
            className="pointer-events-auto border border-hairline-strong bg-surface-2 shadow-lg"
          >
            <div className="flex items-start gap-2 px-3 pt-2">
              <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="text-[length:var(--fs-11)] text-ink-1">{suggestion.title}</div>
                <div className="mt-0.5 text-[length:var(--fs-10)] text-ink-3">
                  {suggestion.detail}
                </div>
                {command ? (
                  <code
                    className="mt-1 block truncate font-mono text-[length:var(--fs-10)] text-ink-4"
                    title={command}
                  >
                    {command}
                  </code>
                ) : null}
              </div>
              <button
                type="button"
                title="Dismiss"
                aria-label={`Dismiss: ${suggestion.title}`}
                onClick={() => onDismiss(suggestion.id)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-4 hover:bg-surface-3 hover:text-ink-1"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-2">
              {suggestion.actions.map((action) => (
                <button
                  key={action.kind}
                  type="button"
                  onClick={() => onAction(suggestion, action)}
                  className={cn(
                    "rounded-sm px-2 py-0.5 text-[length:var(--fs-11)]",
                    action.primary
                      ? "bg-brand text-brand-foreground hover:opacity-90"
                      : "border border-border text-ink-2 hover:bg-surface-3 hover:text-ink-1",
                  )}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

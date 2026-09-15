/**
 * The titlebar's word about a new version: offer it, show it arriving, or ask
 * for the restart that finishes it.
 *
 * Nothing at all when there is nothing to say. A titlebar is not the place for
 * "you are up to date" — that lives in Settings → Updates, for anyone asking.
 */

import { ArrowUpCircle, RotateCw } from "lucide-react";

import { installUpdate, restartToUpdate, useUpdates } from "@/lib/updates";

const PILL =
  "mr-1 inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-2 text-[length:var(--fs-10)]";

export function UpdateBadge() {
  const { state, progress } = useUpdates();
  if (state === null || state.unsupported !== null) return null;

  if (state.installed !== null) {
    return (
      <button
        type="button"
        title={`Version ${state.installed} is installed. Restart jterm to start using it.`}
        onClick={() => void restartToUpdate()}
        className={`${PILL} bg-brand text-brand-foreground hover:opacity-90`}
      >
        <RotateCw className="h-3 w-3" />
        Restart to update
      </button>
    );
  }

  if (state.installing) {
    const percent =
      progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
    return (
      <span className={`${PILL} border border-border text-ink-3`} role="status">
        {percent === null ? "Updating…" : `Updating… ${percent}%`}
      </span>
    );
  }

  if (state.available !== null) {
    const how =
      state.install === "password"
        ? " Installing asks for your password."
        : state.install === "quits"
          ? " jterm closes while it installs."
          : "";
    return (
      <button
        type="button"
        title={`jterm ${state.available.version} is available.${how}`}
        onClick={() => void installUpdate()}
        className={`${PILL} border border-brand text-brand hover:bg-brand/10`}
      >
        <ArrowUpCircle className="h-3 w-3" />
        Update to {state.available.version}
      </button>
    );
  }

  return null;
}

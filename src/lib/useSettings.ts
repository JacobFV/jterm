import { useSyncExternalStore } from "react";

import { subscribeSystemScheme, systemScheme } from "@/lib/appearance";
import { getSettings, subscribeSettings, type Settings } from "@/state/settings";

/**
 * The current settings, re-rendering the caller when they change.
 *
 * `useSyncExternalStore` rather than a context: the store outlives React and is
 * written to from a Tauri event handler as well as from the UI, and both
 * windows read the same module. A provider would only add a tree to keep in
 * step with a store that is already the single copy.
 */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

/**
 * Which foundation the desktop is currently asking for, re-rendering on a flip.
 *
 * Only interesting to a component that computes colours during render, which is
 * to say the one that dresses each pane: a theme chosen for a single pane is
 * written into that pane's own style attribute, so `system` moving under it has
 * to reach React rather than only reaching the document. See `themeStyle`.
 */
export function useSystemScheme(): "dark" | "light" {
  return useSyncExternalStore(subscribeSystemScheme, systemScheme, () => "dark");
}

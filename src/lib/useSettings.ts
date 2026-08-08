import { useSyncExternalStore } from "react";

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

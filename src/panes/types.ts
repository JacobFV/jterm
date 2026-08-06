import type { PaneState } from "@/state/workspace";

/**
 * What every pane kind is handed.
 *
 * Deliberately small. A pane gets its own state, whether it is the focused one,
 * and two ways to talk back — that is the whole contract, and adding a kind
 * means implementing this and adding a line to `registry.tsx`.
 */
export interface PaneProps<T extends PaneState = PaneState> {
  pane: T;
  /** True when this is the pane the keyboard belongs to. */
  focused: boolean;
  /** True when the pane is on screen — its tab is active and it is not hidden
   *  behind a zoomed sibling. Panes that own an expensive resource use this to
   *  stand down without being unmounted. */
  visible: boolean;
  /** Report something the pane discovered about itself: a title, a directory. */
  onMeta: (patch: Partial<T>) => void;
  /** Ask to become the focused pane, e.g. because it was clicked. */
  onFocus: () => void;
}

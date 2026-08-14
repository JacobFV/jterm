import type { ThemeChoice } from "@/state/settings";
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
  /**
   * The theme this pane is standing in — its own, else its tab's, else the
   * app's.
   *
   * Not the colours, and not something a pane needs in order to *be* themed:
   * the tokens are already on the pane's box and every stylesheet in here reads
   * them. It is here for the one thing that cannot work that way — xterm copies
   * the palette into its own styles when it is handed one, so a terminal has to
   * be told the values have moved. Anything drawn with CSS should ignore this.
   */
  theme: ThemeChoice;
  /** Report something the pane discovered about itself: a title, a directory. */
  onMeta: (patch: Partial<T>) => void;
  /** Ask to become the focused pane, e.g. because it was clicked. */
  onFocus: () => void;
}

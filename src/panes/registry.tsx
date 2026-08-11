/**
 * The list of things a pane can be, and what the new-tab menu offers.
 *
 * Adding a kind is: write a component taking `PaneProps`, add a variant to
 * `PaneKind` in `state/workspace.ts` so it can be persisted, teach
 * `lib/filetypes.ts` which files belong to it, and add one entry here. Nothing
 * else in the app switches on pane kind — the tab strip, the split menus and
 * the grid all read this table.
 *
 * The menu is a separate list because it is not the same thing as the set of
 * kinds. `Open file…` is one entry that can produce any of four kinds, and the
 * viewers have no menu entry at all: there is no such thing as an empty image
 * pane to create.
 */

import type { ComponentType } from "react";
import {
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Box,
  PlayCircle,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

import { history, pty, scrollback } from "@/lib/ipc";
import { disposeSession } from "@/lib/tmux";
import { dropContent } from "@/state/content";
import type { PaneKind, PaneState, TerminalPaneState } from "@/state/workspace";
import { BrowserPane } from "./BrowserPane";
import { ImagePane } from "./ImagePane";
import { MediaPane } from "./MediaPane";
import { ModelPane } from "./ModelPane";
import { NotepadPane } from "./NotepadPane";
import { TerminalPane } from "./TerminalPane";
import type { PaneProps } from "./types";

export interface PaneKindDef {
  kind: PaneKind;
  label: string;
  icon: LucideIcon;
  // The registry is where the type of a pane's state stops being known
  // statically; each component narrows its own prop back to its own state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: ComponentType<PaneProps<any>>;
  /**
   * Release whatever the pane owns outside React. Called when a pane is closed
   * for good — not on an ordinary unmount, which also happens when a tab is
   * torn down at exit and must not kill anything.
   *
   * Handed the whole pane rather than its id, because what a terminal owns now
   * depends on what it is: a tmux-backed pane has a session to end as well as a
   * pty to close, and only the pane knows which session.
   */
  dispose?: (pane: PaneState) => void;
}

export const PANE_KINDS: PaneKindDef[] = [
  {
    kind: "terminal",
    label: "Terminal",
    icon: TerminalSquare,
    Component: TerminalPane,
    dispose: (pane) => {
      void pty.kill(pane.id);
      void scrollback.drop(pane.id);
      void history.drop(pane.id);
      // Closing a pane means the shell is finished with, so the session jterm
      // made for it goes too. Quitting the app does not come through here, and
      // that asymmetry is the feature: what survives a crash is exactly what
      // was never deliberately closed.
      disposeSession(pane.id, (pane as TerminalPaneState).tmux);
    },
  },
  { kind: "notepad", label: "Notepad", icon: FileText, Component: NotepadPane },
  { kind: "browser", label: "Browser", icon: Globe, Component: BrowserPane },
  { kind: "image", label: "Image", icon: ImageIcon, Component: ImagePane },
  { kind: "media", label: "Media", icon: PlayCircle, Component: MediaPane },
  { kind: "model", label: "3D model", icon: Box, Component: ModelPane },
];

const BY_KIND = new Map(PANE_KINDS.map((definition) => [definition.kind, definition]));

export function paneKind(kind: PaneKind): PaneKindDef {
  const definition = BY_KIND.get(kind);
  if (definition === undefined) {
    throw new Error(`no pane kind registered for "${kind}"`);
  }
  return definition;
}

/** Everything a closing pane owns, given up in one place. */
export function disposePane(pane: PaneState): void {
  BY_KIND.get(pane.kind)?.dispose?.(pane);
  dropContent(pane.id);
}

/* ── What the new-tab menu offers ────────────────────────────────────────── */

export type NewPaneChoice =
  | { action: "create"; kind: PaneKind; label: string; icon: LucideIcon }
  | { action: "open"; label: string; icon: LucideIcon };

export const NEW_PANE_MENU: NewPaneChoice[] = [
  { action: "create", kind: "terminal", label: "Terminal", icon: TerminalSquare },
  { action: "create", kind: "notepad", label: "Notepad (new)", icon: FileText },
  { action: "open", label: "Open file…", icon: FolderOpen },
  { action: "create", kind: "browser", label: "Browser", icon: Globe },
];

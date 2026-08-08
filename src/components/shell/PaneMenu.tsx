/**
 * A pane's kind icon, made into the control that changes what the pane is.
 *
 * The icon was already there and already said "this is a terminal" — this makes
 * it say "and it need not be". It appears twice: in a pane's header when the tab
 * is split, and in the tab strip, where it is the only one visible for a tab
 * that holds a single pane and would otherwise have no header at all.
 *
 * Two different things are on offer, and they differ in what they cost:
 *
 *   - **Replace with** makes a fresh pane in this one's place. The pane that was
 *     here is closed, so it is routed through the same confirm-and-dispose path
 *     as the close button.
 *   - **Move a tab here** brings another tab's panes into this slot and sends
 *     this pane out as a tab of its own. Nothing is destroyed; see `tab/absorb`.
 */

import { Layers } from "lucide-react";

import { cn } from "@/lib/utils";
import { NEW_PANE_MENU, paneKind } from "@/panes/registry";
import { type PaneKind, type PaneState, type Tab, focusedPane, paneLabel, tabLabel } from "@/state/workspace";
import { Menu, MenuHeading, MenuItem, useMenu } from "./Menu";

export interface PaneMenuActions {
  /** Put a fresh pane of this kind where the given pane is. */
  onReplace: (tabId: string, paneId: string, kind: PaneKind) => void;
  /** The same, with the file chosen from a dialog deciding the kind. */
  onReplaceWithFile: (tabId: string, paneId: string) => void;
  /** Move another tab's panes into this pane's slot. */
  onAbsorbTab: (tabId: string, paneId: string, sourceTabId: string) => void;
}

interface PaneMenuProps {
  /** Every tab there is, so the menu can offer the others. */
  tabs: Tab[];
  /** The tab this pane belongs to — never a candidate to move into itself. */
  tabId: string;
  pane: PaneState;
  actions: PaneMenuActions;
  /** Dimmed when the pane, or its tab, is not the one being looked at. */
  muted?: boolean;
}

export function PaneMenu({ tabs, tabId, pane, actions, muted = false }: PaneMenuProps) {
  const menu = useMenu();
  const Icon = paneKind(pane.kind).icon;
  const others = tabs.filter((tab) => tab.id !== tabId);

  return (
    <div ref={menu.wrapRef} className="flex shrink-0 items-center">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={`${paneLabel(pane)} — change what this pane shows`}
        aria-label={`Change what ${paneLabel(pane)} shows`}
        // The tab strip starts a drag on pointerdown and a pane header takes
        // focus on mousedown; neither is what pressing this means.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          menu.toggle();
        }}
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-sm hover:bg-surface-3 hover:text-ink-1",
          menu.open ? "text-ink-1" : muted ? "text-ink-4" : "text-ink-2",
        )}
      >
        <Icon className="h-3 w-3" />
      </button>

      {menu.anchor ? (
        <Menu anchor={menu.anchor} menuRef={menu.menuRef}>
          <MenuHeading>Replace with</MenuHeading>
          {NEW_PANE_MENU.map((choice) => (
            <MenuItem
              key={choice.action === "open" ? "open" : choice.kind}
              icon={choice.icon}
              label={choice.label}
              onSelect={() => {
                menu.close();
                if (choice.action === "open") actions.onReplaceWithFile(tabId, pane.id);
                else actions.onReplace(tabId, pane.id, choice.kind);
              }}
            />
          ))}

          {others.length > 0 ? (
            <>
              <MenuHeading divided>Move a tab here</MenuHeading>
              {others.map((tab) => {
                const front = focusedPane(tab);
                return (
                  <MenuItem
                    key={tab.id}
                    icon={front ? paneKind(front.kind).icon : Layers}
                    label={tabLabel(tab)}
                    onSelect={() => {
                      menu.close();
                      actions.onAbsorbTab(tabId, pane.id, tab.id);
                    }}
                  />
                );
              })}
            </>
          ) : null}
        </Menu>
      ) : null}
    </div>
  );
}

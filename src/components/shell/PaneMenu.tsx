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
 *
 * And **Move to**, which changes where the pane *is* rather than what it is: onto
 * the rail as a pop-up, beside another pane as a split, into another tab, or
 * into another window. Every one of those keeps the pane's id, so the shell
 * behind it does not restart — see `pane/moveTo`. It is offered from a pane's
 * own header, from a pop-up's, and from a tab whose single pane leaves no doubt
 * about which pane is meant.
 *
 * And **Theme**, which is neither: it changes nothing about what this pane is.
 * It is here because this is the menu that is always one press away from
 * wherever you are looking, and a theme is the setting people change most often
 * and would otherwise have to open a second window to reach.
 *
 * Which theme it changes is what `scope` decides, and it follows from where the
 * icon is rather than being a second thing to learn. In the tab strip the icon
 * stands for the tab, so it themes the tab and every pane in it. In a split
 * pane's header it stands for that pane, so it themes that pane alone. A tab
 * with one pane has no header and therefore only the first, which is right:
 * with nothing to tell apart, "this pane" and "this tab" are the same request.
 */

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import {
  AppWindow,
  Columns2,
  Layers,
  Move,
  PictureInPicture2,
  Palette,
  Plus,
  Shapes,
  Wand2,
} from "lucide-react";

import { useSettings } from "@/lib/useSettings";
import { otherWindows, type WindowRef } from "@/lib/windows";
import { cn } from "@/lib/utils";
import { PROGRAMS, type Program } from "@/lib/programs";
import { NEW_PANE_MENU, paneIcon, paneKind, tabIcon } from "@/panes/registry";
import { countPanes, paneIds } from "@/state/tree";
import type { ThemeChoice } from "@/state/settings";
import {
  type MoveTarget,
  type PaneKind,
  type PaneState,
  type Tab,
  focusedPane,
  paneLabel,
  tabLabel,
  themeOf,
} from "@/state/workspace";
import { Menu, MenuHeading, MenuItem, MenuSubmenu, useMenu } from "./Menu";
import { ThemeMenu } from "./ThemeMenu";

export interface PaneMenuActions {
  /** Put a fresh pane of this kind where the given pane is. */
  onReplace: (paneId: string, kind: PaneKind) => void;
  /** The same, with the file chosen from a dialog deciding the kind. */
  onReplaceWithFile: (paneId: string) => void;
  /** Move another tab's panes into this pane's slot. */
  onAbsorbTab: (tabId: string, paneId: string, sourceTabId: string) => void;
  /** Dress a whole tab. `undefined` puts it back to following the app. */
  onTabTheme: (tabId: string, theme: ThemeChoice | undefined) => void;
  /** Dress one pane. `undefined` puts it back to following its tab. */
  onPaneTheme: (paneId: string, theme: ThemeChoice | undefined) => void;
  /** Send this pane somewhere else in this window, keeping it running. */
  onMovePane: (paneId: string, to: MoveTarget) => void;
  /** Send it to another window, or to a new one when the label is `null`. */
  onMoveToWindow: (paneId: string, label: string | null) => void;
  /** Pin an icon to a tab or a pane. `undefined` goes back to working it out. */
  onTabProfile: (tabId: string, profile: string | undefined) => void;
  onPaneProfile: (paneId: string, profile: string | undefined) => void;
}

interface PaneMenuProps {
  /** Every tab there is, so the menu can offer the others. */
  tabs: Tab[];
  /** The tab this pane belongs to, or `null` for a pane floating on the rail.
   *  A pane's own tab is never a candidate to move it into. */
  tab: Tab | null;
  /** Which tab is on screen, so a floating pane's "beside this pane" list has
   *  somewhere to point at. */
  activeTabId: string | null;
  pane: PaneState;
  /** Whether this icon is standing for its tab or for its pane. See above. */
  scope: "tab" | "pane";
  actions: PaneMenuActions;
  /** Dimmed when the pane, or its tab, is not the one being looked at. */
  muted?: boolean;
}

/**
 * The handle a tab uses to open this menu from a right-click.
 *
 * The menu belongs to the icon, but the *gesture* belongs to the whole tab, and
 * the tab is this component's parent rather than its child. Rather than lift
 * the menu's state up into the tab strip — where nothing else needs it — the
 * tab is handed this one verb.
 */
export interface PaneMenuHandle {
  openAt: (x: number, y: number) => void;
}

/** The families the icon picker is grouped by, in the order it shows them. */
const GROUPS: Program["group"][] = ["AI", "Development", "Operations", "Data", "Shell"];

export const PaneMenu = forwardRef<PaneMenuHandle, PaneMenuProps>(function PaneMenu(
  { tabs, tab, activeTabId, pane, scope, actions, muted = false },
  ref,
) {
  const settings = useSettings();
  const menu = useMenu();
  // What the icon shows is what the thing *is*, which for a tab is the tab's
  // own answer and for a pane is the pane's. See `paneIcon`.
  const Icon = scope === "tab" && tab !== null ? tabIcon(tab) : paneIcon(pane);
  const others = tabs.filter((other) => other.id !== tab?.id);

  useImperativeHandle(ref, () => ({ openAt: menu.revealAt }), [menu.revealAt]);

  /**
   * The other windows, asked for while the menu is open.
   *
   * Not held in the app's state: windows are opened and closed by the platform
   * as much as by this app, and a list kept up to date all session long would
   * be a subscription maintained for a submenu almost nobody opens. Asking at
   * the moment of the question is both simpler and more accurate.
   */
  const [windows, setWindows] = useState<WindowRef[]>([]);
  useEffect(() => {
    if (!menu.open) return;
    let cancelled = false;
    void otherWindows().then((found) => {
      if (!cancelled) setWindows(found);
    });
    return () => {
      cancelled = true;
    };
  }, [menu.open]);

  // The two levels this icon can be standing for, told apart in one place so
  // the menu below reads the same whichever it is. A floating pane has no tab,
  // so for it there is only ever the pane's own.
  const asTab = scope === "tab" && tab !== null;
  const themed = asTab ? tab.theme : pane.theme;
  const defer = asTab
    ? { label: "Follow the app", resolves: settings.theme }
    : { label: tab === null ? "Follow the app" : "Follow the tab", resolves: themeOf(settings.theme, tab) };
  const setTheme = (choice: ThemeChoice | undefined) =>
    asTab ? actions.onTabTheme(tab.id, choice) : actions.onPaneTheme(pane.id, choice);

  // The icon is chosen at whichever level this menu is standing for, the same
  // way the theme is: from the strip it names the tab, from a header the pane.
  const chosenProfile = asTab ? tab.profile : pane.profile;
  const setProfile = (profile: string | undefined) =>
    asTab ? actions.onTabProfile(tab.id, profile) : actions.onPaneProfile(pane.id, profile);

  /**
   * Panes this one could be put beside.
   *
   * Its own tab's, or — for a pane on the rail, which is in no tab — whichever
   * tab is on screen, since that is the one the user is looking at while they
   * ask. Itself is never in the list: a pane cannot be split against itself.
   */
  const host = tab ?? tabs.find((candidate) => candidate.id === activeTabId) ?? null;
  const neighbours =
    host === null
      ? []
      : paneIds(host.root)
          .filter((paneId) => paneId !== pane.id)
          .map((paneId) => host.panes[paneId])
          .filter((candidate): candidate is PaneState => candidate !== undefined);

  /**
   * Whether this menu may move the pane at all.
   *
   * From a pane header or a pop-up header it always may. From the tab strip it
   * may only when the tab holds one pane — with two, "move this" has no answer,
   * because the icon in the strip stands for the tab rather than for either of
   * the panes in it.
   */
  const movable = scope === "pane" || tab === null || countPanes(tab.root) === 1;
  const floating = tab === null;
  const move = (to: MoveTarget) => {
    menu.close();
    actions.onMovePane(pane.id, to);
  };

  return (
    <div ref={menu.wrapRef} className="flex shrink-0 items-center">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={
          asTab
            ? `${tabLabel(tab)} — theme this tab, or change what it shows`
            : `${paneLabel(pane)} — theme this pane, move it, or change what it shows`
        }
        aria-label={`Menu for ${asTab ? tabLabel(tab) : paneLabel(pane)}`}
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

      <Menu menu={menu}>
        <MenuSubmenu icon={Palette} label={asTab ? "Tab theme" : "Pane theme"}>
          <ThemeMenu value={themed} defer={defer} onChange={setTheme} onPick={menu.close} />
        </MenuSubmenu>

        <MenuSubmenu icon={Shapes} label="Icon">
          <MenuItem
            icon={Wand2}
            label="Work it out"
            selected={chosenProfile === undefined}
            onSelect={() => {
              menu.close();
              setProfile(undefined);
            }}
          />
          {GROUPS.map((group) => (
            <div key={group}>
              <MenuHeading divided>{group}</MenuHeading>
              {PROGRAMS.filter((program) => program.group === group).map((program) => (
                <MenuItem
                  key={program.id}
                  icon={program.icon}
                  label={program.label}
                  selected={chosenProfile === program.id}
                  onSelect={() => {
                    menu.close();
                    setProfile(program.id);
                  }}
                />
              ))}
            </div>
          ))}
        </MenuSubmenu>

        {movable ? (
          <MenuSubmenu icon={Move} label="Move to">
            {floating ? null : (
              <MenuItem
                icon={PictureInPicture2}
                label="New pop up"
                onSelect={() => move({ kind: "popup" })}
              />
            )}

            {neighbours.length > 0 ? (
              <MenuSubmenu icon={Columns2} label="Split pane">
                {neighbours.map((neighbour) => (
                  <MenuItem
                    key={neighbour.id}
                    icon={paneKind(neighbour.kind).icon}
                    label={paneLabel(neighbour)}
                    onSelect={() => move({ kind: "split", paneId: neighbour.id })}
                  />
                ))}
              </MenuSubmenu>
            ) : null}

            <MenuSubmenu icon={AppWindow} label="Other windows">
              {windows.map((other) => (
                <MenuItem
                  key={other.label}
                  icon={AppWindow}
                  label={other.title || other.label}
                  onSelect={() => {
                    menu.close();
                    actions.onMoveToWindow(pane.id, other.label);
                  }}
                />
              ))}
              <MenuItem
                icon={Plus}
                label="New window"
                onSelect={() => {
                  menu.close();
                  actions.onMoveToWindow(pane.id, null);
                }}
              />
            </MenuSubmenu>

            <MenuSubmenu icon={Layers} label="Tabs">
              {others.map((destination) => {
                const front = focusedPane(destination);
                return (
                  <MenuItem
                    key={destination.id}
                    icon={front ? paneKind(front.kind).icon : Layers}
                    label={tabLabel(destination)}
                    onSelect={() => move({ kind: "tab", tabId: destination.id })}
                  />
                );
              })}
              <MenuItem
                icon={Plus}
                label="New tab"
                onSelect={() => move({ kind: "newTab" })}
              />
            </MenuSubmenu>
          </MenuSubmenu>
        ) : null}

        <MenuHeading divided>Replace with</MenuHeading>
        {NEW_PANE_MENU.map((choice) => (
          <MenuItem
            key={choice.action === "open" ? "open" : choice.kind}
            icon={choice.icon}
            label={choice.label}
            onSelect={() => {
              menu.close();
              if (choice.action === "open") actions.onReplaceWithFile(pane.id);
              else actions.onReplace(pane.id, choice.kind);
            }}
          />
        ))}

        {tab !== null && others.length > 0 ? (
          <>
            <MenuHeading divided>Move a tab here</MenuHeading>
            {others.map((source) => {
              const front = focusedPane(source);
              return (
                <MenuItem
                  key={source.id}
                  icon={front ? paneKind(front.kind).icon : Layers}
                  label={tabLabel(source)}
                  onSelect={() => {
                    menu.close();
                    actions.onAbsorbTab(tab.id, pane.id, source.id);
                  }}
                />
              );
            })}
          </>
        ) : null}
      </Menu>
    </div>
  );
});

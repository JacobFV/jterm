/**
 * The settings window.
 *
 * A whole window rather than a sheet over the app, because almost everything in
 * here is a thing you adjust *while looking at the result*. Choosing a terminal
 * font size with the terminal covered up is guesswork; a modal is exactly the
 * shape that guarantees it. So this is a second real window, it writes on every
 * change rather than on an OK button, and the main window repaints as you drag.
 *
 * It is the same bundle and the same design tokens as the app — see
 * `lib/settingsWindow.ts` for how the one `index.html` serves both — which also
 * means it gets the app's window chrome for free: the platform's own titlebar
 * on macOS, jterm's on Windows and Linux.
 */

import { useCallback, useEffect, useState } from "react";

import { ResizeHandles } from "@/components/shell/ResizeHandles";
import { WindowControls } from "@/components/shell/WindowControls";
import { WindowFrame } from "@/components/shell/WindowFrame";
import { dialog } from "@/lib/ipc";
import { displayKeys, keysFor, type ActionId } from "@/lib/keymap";
import { MACOS_TRAFFIC_LIGHT_INSET_PX, usesNativeWindowChrome } from "@/lib/platform";
import { useIsFullscreen } from "@/lib/useFullscreen";
import { swatch, THEME_GROUPS, THEMES } from "@/lib/themes";
import { tmuxAvailable } from "@/lib/tmux";
import { cn } from "@/lib/utils";
import { DEFAULTS, LIMITS, resetSettings, updateSettings } from "@/state/settings";
import { useSettings } from "@/lib/useSettings";
import { KeyBindings } from "./KeyBindings";
import { SessionData } from "./SessionData";
import { Button, NumberInput, Row, Section, Segmented, Slider, TextInput, Toggle } from "./controls";

/**
 * Every theme, as a grid of the thing itself.
 *
 * A list of names would be useless here: nobody knows what "Kanagawa" looks
 * like, and the whole reason this window is a window is so a choice can be
 * seen. Each cell is a miniature of a terminal in that theme — its own
 * background, a hairline in its own border colour, and a line of its own hues —
 * so the grid answers the question the names cannot.
 */
function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="space-y-3">
      {["", ...THEME_GROUPS].map((group) => {
        // The empty group is `system`, which has no palette and so no cell of
        // its own kind; it gets the first row to itself.
        const items = group === "" ? [null] : THEMES.filter((theme) => theme.group === group);
        return (
          <div key={group || "system"}>
            {group ? (
              <div className="pane-title mb-1.5 text-[length:var(--fs-9)]">{group}</div>
            ) : null}
            <div className="grid grid-cols-3 gap-1.5">
              {items.map((theme) => {
                const id = theme?.id ?? "system";
                const active = value === id;
                const hues = theme ? swatch(theme) : null;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onChange(id)}
                    title={theme ? theme.name : "Follow the desktop"}
                    className={cn(
                      "flex flex-col gap-1 border p-1.5 text-left",
                      active
                        ? "border-brand"
                        : "border-hairline-strong hover:border-ink-4",
                    )}
                  >
                    <span
                      className="flex h-6 items-end gap-px overflow-hidden px-1 pb-1"
                      style={{
                        background: hues ? hues[0] : "linear-gradient(90deg, #000 50%, #fff 50%)",
                      }}
                    >
                      {(hues ?? []).slice(1).map((hue, index) => (
                        <span
                          key={index}
                          className="flex-1"
                          // Stepped heights, so the row reads as a little bar
                          // chart of the palette rather than as a flat ribbon.
                          style={{ background: hue, height: `${5 + (index % 3) * 4}px` }}
                        />
                      ))}
                    </span>
                    <span
                      className={cn(
                        "truncate text-[length:var(--fs-10)]",
                        active ? "text-brand" : "text-ink-2",
                      )}
                    >
                      {theme ? theme.name : "System"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The keyboard's half of the font size, named rather than described.
 *
 * Read from the binding table rather than written out, so rebinding zoom in
 * the section below rewrites this sentence too — and unbinding it removes the
 * sentence instead of leaving a shortcut that no longer exists in a hint.
 */
function zoomHint(): string {
  const zoomIn = keysFor("view.zoomIn");
  const zoomOut = keysFor("view.zoomOut");
  if (!zoomIn || !zoomOut) return "";
  return ` ${displayKeys(zoomIn)} and ${displayKeys(zoomOut)} move it from the keyboard.`;
}

export function SettingsWindow() {
  const settings = useSettings();

  // This window is its own webview, so it asks for itself rather than being
  // told — there is nothing shared between the two but the settings file.
  const [hasTmux, setHasTmux] = useState(false);
  useEffect(() => {
    void tmuxAvailable().then(setHasTmux);
  }, []);

  const setKeys = useCallback((keys: Partial<Record<ActionId, string>>) => {
    updateSettings({ keys });
  }, []);

  const resetAll = async () => {
    const sure = await dialog.confirm(
      "Put every setting — theme, sizes, shortcuts and all — back to how jterm ships?",
      "Reset all settings?",
    );
    if (sure) resetSettings();
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-0">
      <TitleBar />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Appearance">
          <Row
            label="Theme"
            hint={
              <>
                Also on any tab: right-click it, or click its kind icon, for{" "}
                <strong className="font-normal text-ink-2">Theme</strong>. Following the system
                switches with it, live. The <strong className="font-normal text-ink-2">Living</strong>{" "}
                themes draw behind the panes and go still under reduced motion.
              </>
            }
            stacked
          >
            <ThemePicker value={settings.theme} onChange={(theme) => updateSettings({ theme })} />
          </Row>

          <Row label="Interface size" hint="Tabs, the file tree, pane titles — not the terminal.">
            <Slider
              label="Interface size"
              value={settings.uiFontSize}
              onChange={(uiFontSize) => updateSettings({ uiFontSize })}
              {...LIMITS.uiFontSize}
              format={(value) => `${value} px`}
            />
          </Row>
        </Section>

        <Section title="Terminal">
          <Row
            label="Font"
            stacked
            hint="A family name, or a whole CSS stack if you want one. Empty uses the built-in stack, which is what everything falls back to anyway if the font you name is missing."
          >
            <TextInput
              label="Terminal font"
              value={settings.fontFamily}
              placeholder="JetBrains Mono"
              onChange={(fontFamily) => updateSettings({ fontFamily })}
            />
          </Row>

          <Row
            label="Font size"
            hint={`The terminal and the text panes, which are drawn at one size on purpose.${zoomHint()}`}
          >
            <Slider
              label="Font size"
              value={settings.fontSize}
              onChange={(fontSize) => updateSettings({ fontSize })}
              {...LIMITS.fontSize}
              format={(value) => `${value} px`}
            />
          </Row>

          <Row label="Line height">
            <Slider
              label="Line height"
              value={settings.lineHeight}
              onChange={(lineHeight) => updateSettings({ lineHeight })}
              {...LIMITS.lineHeight}
              format={(value) => value.toFixed(2)}
            />
          </Row>

          <Row label="Cursor">
            <Segmented
              label="Cursor style"
              value={settings.cursorStyle}
              onChange={(cursorStyle) => updateSettings({ cursorStyle })}
              options={[
                { value: "bar", label: "Bar" },
                { value: "block", label: "Block" },
                { value: "underline", label: "Underline" },
              ]}
            />
          </Row>

          <Row label="Blink the cursor">
            <Toggle
              label="Blink the cursor"
              value={settings.cursorBlink}
              onChange={(cursorBlink) => updateSettings({ cursorBlink })}
            />
          </Row>

          <Row
            label="Scrollback"
            hint="Lines each terminal keeps in memory. What survives a restart is the log on disk, which is capped separately."
          >
            <NumberInput
              label="Scrollback lines"
              value={settings.scrollback}
              onChange={(scrollback) => updateSettings({ scrollback })}
              {...LIMITS.scrollback}
            />
          </Row>

          <Row
            label="Shell"
            stacked
            hint="Empty means whatever the system considers your login shell. Terminals already open keep the shell they started with."
          >
            <TextInput
              label="Shell"
              value={settings.shell}
              placeholder={DEFAULTS.shell || "$SHELL"}
              onChange={(shell) => updateSettings({ shell })}
            />
          </Row>
        </Section>

        {/* Only where there is a tmux to talk to. A choice that cannot be
            honoured is worse than one that is not offered — it looks like a
            setting that does not work. */}
        {hasTmux ? (
          <Section title="tmux">
            <Row
              label="New terminals run on"
              hint="A shell is jterm's own: it dies with the app, and what survives a crash is the snapshot jterm keeps of it. A tmux session outlives the app, so a restored tab reattaches to the shell itself rather than to a picture of it — and jterm stops keeping its own copy, since tmux already has one."
            >
              <Segmented
                label="New terminals run on"
                value={settings.shellBackend}
                onChange={(shellBackend) => updateSettings({ shellBackend })}
                options={[
                  { value: "direct", label: "A shell" },
                  { value: "tmux", label: "A tmux session" },
                ]}
              />
            </Row>

            <Row
              label="Pane shortcuts drive tmux"
              hint="In a pane that is in tmux, splitting and moving between panes acts on tmux's panes rather than jterm's — so the split lands in the session that survives. Moving off the edge of a tmux layout still arrives at the jterm pane next door. Turn this off to split jterm around the tmux pane instead."
            >
              <Toggle
                label="Pane shortcuts drive tmux"
                value={settings.tmuxKeys}
                onChange={(tmuxKeys) => updateSettings({ tmuxKeys })}
              />
            </Row>
          </Section>
        ) : null}

        <Section title="Files">
          <Row
            label="Open files in"
            hint="Where a file goes when you pick one in the file tree or the open dialog. The + button's own “Open file…” always makes a tab."
          >
            <Segmented
              label="Open files in"
              value={settings.openFilesIn}
              onChange={(openFilesIn) => updateSettings({ openFilesIn })}
              options={[
                { value: "tab", label: "New tab" },
                { value: "pane", label: "New pane" },
              ]}
            />
          </Row>

          {/* Only worth asking once the answer above makes it mean something. */}
          {settings.openFilesIn === "pane" ? (
            <Row label="New pane goes" hint="Which side of the focused pane it splits off.">
              <Segmented
                label="New pane goes"
                value={settings.openPaneDirection}
                onChange={(openPaneDirection) => updateSettings({ openPaneDirection })}
                options={[
                  { value: "right", label: "Right" },
                  { value: "left", label: "Left" },
                  { value: "down", label: "Down" },
                  { value: "up", label: "Up" },
                ]}
              />
            </Row>
          ) : null}
        </Section>

        <Section title="File tree">
          <Row label="Width">
            <Slider
              label="Sidebar width"
              value={settings.sidebarWidth}
              onChange={(sidebarWidth) => updateSettings({ sidebarWidth })}
              {...LIMITS.sidebarWidth}
              format={(value) => `${value} px`}
            />
          </Row>

          <Row label="Show hidden files" hint="Dotfiles, and whatever else the platform hides.">
            <Toggle
              label="Show hidden files"
              value={settings.showHiddenFiles}
              onChange={(showHiddenFiles) => updateSettings({ showHiddenFiles })}
            />
          </Row>
        </Section>

        <Section title="Keyboard">
          <KeyBindings keys={settings.keys} onChange={setKeys} />
        </Section>

        <Section title="Your data">
          <SessionData />
        </Section>

        <Section title="Start over">
          <Row
            label="Reset everything"
            hint="Every setting on this page back to the default. Your tabs and terminals are untouched."
          >
            <Button danger onClick={() => void resetAll()}>
              Reset all settings
            </Button>
          </Row>
        </Section>
      </div>

      <ResizeHandles />
      <WindowFrame />
    </div>
  );
}

/**
 * The window's own titlebar, matching the app's.
 *
 * macOS keeps its native traffic lights floating over the webview, so all this
 * owes it is the inset to sit clear of them. Windows and Linux get jterm's
 * buttons, which `WindowControls` draws in the local idiom and which know
 * nothing about which window they are in.
 */
function TitleBar() {
  // Asked per window, so this answers for the settings window rather than for
  // the app's. It is unlikely ever to be true here, but a rule that holds only
  // where someone expected it to be needed is the kind that stops holding.
  const fullscreen = useIsFullscreen();
  const inset = usesNativeWindowChrome() && !fullscreen ? MACOS_TRAFFIC_LIGHT_INSET_PX : 0;
  return (
    <div
      data-tauri-drag-region
      className="flex h-head shrink-0 cursor-default select-none items-center border-b border-border bg-surface-1"
    >
      <div data-tauri-drag-region className="shrink-0" style={{ width: inset }} />
      <span data-tauri-drag-region className="pane-title flex-1 px-2">
        Settings
      </span>
      <WindowControls maximize={false} />
    </div>
  );
}

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
import { dialog } from "@/lib/ipc";
import type { ActionId } from "@/lib/keymap";
import { MACOS_TRAFFIC_LIGHT_INSET_PX, usesNativeWindowChrome } from "@/lib/platform";
import { tmuxAvailable } from "@/lib/tmux";
import { DEFAULTS, LIMITS, resetSettings, updateSettings } from "@/state/settings";
import { useSettings } from "@/lib/useSettings";
import { KeyBindings } from "./KeyBindings";
import { SessionData } from "./SessionData";
import { Button, NumberInput, Row, Section, Segmented, Slider, TextInput, Toggle } from "./controls";

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
          <Row label="Theme" hint="Following the system switches with it, live.">
            <Segmented
              label="Theme"
              value={settings.theme}
              onChange={(theme) => updateSettings({ theme })}
              options={[
                { value: "system", label: "System" },
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
            />
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

          <Row label="Font size">
            <Slider
              label="Terminal font size"
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
  const inset = usesNativeWindowChrome() ? MACOS_TRAFFIC_LIGHT_INSET_PX : 0;
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

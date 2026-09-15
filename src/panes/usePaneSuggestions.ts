/**
 * The suggestions a terminal pane shows, and what pressing each button does.
 *
 * `lib/suggestions.ts` decides *whether* to offer something; this is the half
 * that has to live next to a shell. It gathers the facts those rules read —
 * whether the pane lost its shell, whether anything is running in it now,
 * whether tmux is here — and it carries each button out through the few things
 * `TerminalPane` lets it do to the shell.
 *
 * It also keeps `pane.agent` current. The same poll that answers "is anything
 * running" answers "is it an agent, and which conversation", and recording that
 * while the process is alive is the only way to have it on the day it is not.
 * Every pane is polled, visible or not: the one that most needs its agent
 * remembered is the background tab that has been working for an hour.
 */

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentFromForeground, sameAgent } from "@/lib/agents";
import { pty } from "@/lib/ipc";
import { type Suggestion, type SuggestionAction, suggestionsFor } from "@/lib/suggestions";
import { tmuxAvailable } from "@/lib/tmux";
import { useSettings } from "@/lib/useSettings";
import { getSettings, updateSettings } from "@/state/settings";
import type { TerminalPaneState } from "@/state/workspace";

/**
 * How often each pane is asked what is in its foreground.
 *
 * Slow, because nothing it feeds is urgent: an agent started a few seconds
 * before a crash is the only thing a longer interval could miss, and a `/proc`
 * read per pane per interval — a tmux query, for a tmux-backed one — is not
 * worth paying every second across a dozen panes.
 */
const FOREGROUND_POLL_MS = 5000;

/** What a suggestion is allowed to do to the pane's shell. */
export interface ShellControls {
  /** Replace the line at the prompt with `command`, and press Enter if `submit`. */
  send(command: string, submit: boolean): void;
  /** Run `command` once a shell that is still starting has printed its prompt. */
  sendWhenReady(command: string): void;
  /** Restart the shell in a tmux session of its own. False if it stayed put. */
  moveToTmux(): Promise<boolean>;
  /** Whether the shell is in a tmux session jterm made for it. */
  onTmux(): boolean;
  focus(): void;
}

export interface PaneSuggestions {
  suggestions: Suggestion[];
  act(suggestion: Suggestion, action: SuggestionAction): void;
  dismiss(id: string): void;
  /** Called by the pane when it came back and its shell did not. */
  markRestored(): void;
  /** Called by the pane when the user starts something, which moves it on. */
  noteCommand(): void;
}

export function usePaneSuggestions(
  pane: TerminalPaneState,
  controls: RefObject<ShellControls | null>,
  onMeta: (patch: Partial<TerminalPaneState>) => void,
): PaneSuggestions {
  const settings = useSettings();
  const [restored, setRestored] = useState(false);
  const [idle, setIdle] = useState(true);
  const [hasTmux, setHasTmux] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const agentRef = useRef(pane.agent);
  agentRef.current = pane.agent;
  const restoredRef = useRef(restored);
  restoredRef.current = restored;
  const metaRef = useRef(onMeta);
  metaRef.current = onMeta;

  useEffect(() => {
    let live = true;
    void tmuxAvailable().then((available) => {
      if (live) setHasTmux(available);
    });
    return () => {
      live = false;
    };
  }, []);

  const control = pane.tmuxPane !== undefined;
  const paneId = pane.id;
  useEffect(() => {
    // A control-mode pane has no shell of its own on this side to ask about.
    if (control) return;
    let live = true;
    const check = () => {
      void pty.foreground(paneId).then((foreground) => {
        if (!live) return;
        setIdle(foreground === null);
        // Something is running: whatever the pane lost, it has moved on.
        if (foreground !== null) setRestored(false);
        // A restored pane keeps the agent it came back with while its shell
        // sits idle. That record is the only way back into the conversation,
        // and a poll finding nothing running yet is not a reason to forget it.
        if (foreground === null && restoredRef.current) return;
        const next = agentFromForeground(foreground);
        if (!sameAgent(agentRef.current, next)) metaRef.current({ agent: next });
      });
    };
    check();
    const timer = window.setInterval(check, FOREGROUND_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [paneId, control]);

  const suggestions = useMemo(
    () =>
      suggestionsFor({
        restored,
        idle,
        agent: pane.agent,
        command: pane.command,
        cwd: pane.cwd,
        onTmux: pane.tmux !== undefined,
        tmuxAvailable: hasTmux,
        newTerminalsOnTmux: settings.shellBackend === "tmux",
        quiet: settings.quietSuggestions,
      }).filter((suggestion) => !dismissed.includes(suggestion.id)),
    [
      restored,
      idle,
      pane.agent,
      pane.command,
      pane.cwd,
      pane.tmux,
      hasTmux,
      settings.shellBackend,
      settings.quietSuggestions,
      dismissed,
    ],
  );

  const dismiss = useCallback((id: string) => {
    setDismissed((current) => (current.includes(id) ? current : [...current, id]));
  }, []);

  const act = useCallback(
    (suggestion: Suggestion, action: SuggestionAction) => {
      const shell = controls.current;
      if (shell === null) return;
      void (async () => {
        switch (action.kind) {
          case "run": {
            if (!action.command) return;
            setRestored(false);
            // A pane resumed after a crash is exactly the pane that should not be
            // exposed to the next one. Where the setting asks for tmux, the shell
            // moves first and the command follows it in once the prompt is up.
            const intoTmux =
              getSettings().shellBackend === "tmux" && !shell.onTmux() && (await tmuxAvailable());
            if (intoTmux && (await shell.moveToTmux())) shell.sendWhenReady(action.command);
            else shell.send(action.command, true);
            break;
          }
          case "type":
            if (action.command) shell.send(action.command, false);
            dismiss(suggestion.id);
            break;
          case "tmux-default":
            updateSettings({ shellBackend: "tmux" });
            await shell.moveToTmux();
            break;
          case "tmux-pane":
            await shell.moveToTmux();
            break;
          case "quiet": {
            const quiet = getSettings().quietSuggestions;
            if (!quiet.includes(suggestion.id)) {
              updateSettings({ quietSuggestions: [...quiet, suggestion.id] });
            }
            break;
          }
        }
        shell.focus();
      })();
    },
    [controls, dismiss],
  );

  const markRestored = useCallback(() => setRestored(true), []);
  const noteCommand = useCallback(() => setRestored(false), []);

  return { suggestions, act, dismiss, markRestored, noteCommand };
}

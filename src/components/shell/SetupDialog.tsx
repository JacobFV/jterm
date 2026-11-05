/**
 * The welcome dialog: a first launch's few minutes of setup, every one of them
 * optional. What it offers, and why tmux is the reason it exists, is in
 * `lib/setup.ts`; this is only the drawing of it.
 *
 * Over the workspace rather than in a window of its own, because the things it
 * changes are things you want to watch change — the theme, the text size —
 * and because a second window on first launch reads as the app opening twice.
 *
 * **Parked.** Installing tmux happens in a terminal, and a terminal is no use
 * under a modal. So the install button opens a tab with the command typed at
 * its prompt and the dialog folds itself into a small card in the corner,
 * leaving the terminal free for Enter and a password. The card's one button
 * checks again and unfolds the dialog where it left off.
 *
 * **Restarted.** App Management is the other step that leaves the app: it is
 * switched on in System Settings and only read when jterm starts. So that step
 * shows what to do there, offers the restart, and leaves a note so the dialog
 * comes back on the same step after it — where the check runs again and, this
 * time, can say yes.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, Fingerprint, Loader2, MousePointer2, Sparkles } from "lucide-react";

import { Button, Row, Segmented, Slider, Toggle } from "@/components/settings/controls";
import { ThemePicker } from "@/components/settings/ThemePicker";
import {
  openExternal,
  permissions,
  setup,
  updates,
  type AppManagement,
  type SetupProbe,
} from "@/lib/ipc";
import { displayKeys, keysFor, labelFor, type ActionId } from "@/lib/keymap";
import { isMacOS, isWindows } from "@/lib/platform";
import {
  SETUP_VERSION,
  rememberResume,
  stepsFor,
  takeResume,
  tmuxOffer,
  type Platform,
  type StepId,
} from "@/lib/setup";
import { recheckTmux } from "@/lib/tmux";
import { useSettings } from "@/lib/useSettings";
import { cn } from "@/lib/utils";
import { LIMITS, updateSettings } from "@/state/settings";

function platform(): Platform {
  return isMacOS() ? "macos" : isWindows() ? "windows" : "linux";
}

/** The shortcuts worth knowing on day one. The rest are in Settings. */
const ESSENTIALS: ActionId[] = [
  "tab.new",
  "pane.splitRight",
  "pane.splitDown",
  "pane.close",
  "history.search",
  "window.settings",
];

export function SetupDialog({
  onClose,
  onInstall,
  onTmuxFound,
}: {
  /** The dialog is done with, finished or skipped. It has already written
   *  down that it was seen. */
  onClose: () => void;
  /** Open a tab with `command` typed at its prompt — and not run. */
  onInstall: (command: string) => void;
  /** tmux turned up after the dialog opened; whoever caches it should know. */
  onTmuxFound: () => void;
}) {
  const settings = useSettings();
  const steps = stepsFor(platform());
  // Where a restart the dialog asked for left off, or the first step.
  const [index, setIndex] = useState(() => takeResume(steps));
  const [probe, setProbe] = useState<SetupProbe | null>(null);
  const [parked, setParked] = useState(false);
  const [checking, setChecking] = useState(false);
  const step = steps[index];
  const last = index === steps.length - 1;

  const check = useCallback(async () => {
    setChecking(true);
    // Both caches, so a tmux that has just been installed is believed
    // everywhere, not only in here.
    const [found, available] = await Promise.all([setup.probe(), recheckTmux()]);
    setProbe(found);
    setChecking(false);
    if (available) onTmuxFound();
  }, [onTmuxFound]);

  useEffect(() => {
    void check();
  }, [check]);

  /** Seen is written on the way out, however the way out was taken. */
  const finish = useCallback(() => {
    updateSettings({ setupSeen: SETUP_VERSION });
    onClose();
  }, [onClose]);

  const nextRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // Off the terminal underneath, so a keystroke meant for the dialog does
    // not end up at a shell prompt.
    if (!parked) nextRef.current?.focus();
  }, [index, parked]);

  const install = (command: string) => {
    onInstall(command);
    setParked(true);
  };

  if (parked) {
    return createPortal(
      <div
        role="status"
        className="fixed bottom-4 right-4 z-50 w-[300px] border border-hairline-strong bg-surface-2 p-3 shadow-lg"
      >
        <div className="text-[length:var(--fs-11)] text-ink-1">Setup is waiting</div>
        <p className="mt-0.5 text-[length:var(--fs-10)] text-ink-3">
          Press Enter in the new tab to install tmux. Come back here when it has finished.
        </p>
        <div className="mt-2 flex justify-end gap-1.5">
          <Button onClick={finish}>Stop setup</Button>
          <button
            type="button"
            onClick={() => {
              setParked(false);
              void check();
            }}
            className="bg-brand px-3 py-1.5 text-[length:var(--fs-12)] text-brand-foreground hover:opacity-90"
          >
            Check and continue
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set up jterm"
        className="flex max-h-[86vh] w-[600px] max-w-[94vw] flex-col border border-hairline-strong bg-surface-1 shadow-lg"
      >
        {/* Where you are, and that there is an end to it. Every step is
            clickable: this is a list of things to look at, not a gauntlet. */}
        <nav className="flex shrink-0 gap-1 border-b border-border px-3 py-2" aria-label="Steps">
          {steps.map((candidate, at) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setIndex(at)}
              aria-current={at === index ? "step" : undefined}
              className={cn(
                "px-2 py-1 text-[length:var(--fs-10)]",
                at === index ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-1",
              )}
            >
              {candidate.title}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <StepBody
            id={step.id}
            probe={probe}
            checking={checking}
            onCheck={() => void check()}
            onInstall={install}
            settings={settings}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={finish}
            className="px-2 py-1 text-[length:var(--fs-11)] text-ink-3 hover:text-ink-1"
          >
            {last ? "Close" : "Skip setup"}
          </button>
          <span className="flex-1" />
          {index > 0 ? <Button onClick={() => setIndex(index - 1)}>Back</Button> : null}
          <button
            ref={nextRef}
            type="button"
            onClick={() => (last ? finish() : setIndex(index + 1))}
            className="bg-brand px-3 py-1.5 text-[length:var(--fs-12)] text-brand-foreground hover:opacity-90"
          >
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="mb-1 text-[length:var(--fs-13)] text-ink-1">{children}</h2>;
}

function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 text-[length:var(--fs-11)] leading-relaxed text-ink-3">{children}</p>
  );
}

function StepBody({
  id,
  probe,
  checking,
  onCheck,
  onInstall,
  settings,
}: {
  id: StepId;
  probe: SetupProbe | null;
  checking: boolean;
  onCheck: () => void;
  onInstall: (command: string) => void;
  settings: ReturnType<typeof useSettings>;
}) {
  switch (id) {
    case "welcome":
      return (
        <>
          <Heading>
            <Sparkles className="mr-1.5 inline h-4 w-4 text-brand" />
            Welcome to jterm
          </Heading>
          <Lede>
            A few things worth setting up before you start, each of them optional. Anything here
            can be changed later in Settings ({displayKeys(keysFor("window.settings"))}), and this
            can be run again from there.
          </Lede>
          <div className="pane-title mb-1.5 text-[length:var(--fs-9)]">Shortcuts to know</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {ESSENTIALS.map((action) => (
              <div key={action} className="contents">
                <dt className="font-mono text-[length:var(--fs-11)] text-ink-1">
                  {displayKeys(keysFor(action))}
                </dt>
                <dd className="text-[length:var(--fs-11)] text-ink-3">
                  {action === "pane.close"
                    ? "Close pane — and the tab, if it was the last"
                    : labelFor(action)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      );

    case "tmux":
      return (
        <TmuxStep
          probe={probe}
          checking={checking}
          onCheck={onCheck}
          onInstall={onInstall}
          backend={settings.shellBackend}
        />
      );

    case "look":
      return (
        <>
          <Heading>Look</Heading>
          <Lede>
            Changes as you pick. The themes that draw something behind the terminal, and a few
            with more character, are in Settings.
          </Lede>
          <div className="space-y-4">
            <Row label="Terminal text size">
              <Slider
                label="Terminal text size"
                value={settings.fontSize}
                onChange={(fontSize) => updateSettings({ fontSize })}
                {...LIMITS.fontSize}
                format={(value) => `${value} px`}
              />
            </Row>
            <ThemePicker
              value={settings.theme}
              onChange={(theme) => updateSettings({ theme })}
              // The still ones. A living theme is a lot to meet on a first
              // launch, and is better found than presented.
              groups={["Foundations", "Palettes"]}
            />
          </div>
        </>
      );

    case "agent":
      return (
        <>
          <Heading>Agent</Heading>
          <Lede>
            The sidebar has an Agent tab that runs a coding agent in the folder you are working
            in, and can see and drive jterm&apos;s panes. Pick the one you use. jterm does not
            install it — it runs whatever your shell finds by that name.
          </Lede>
          <Row label="Agent">
            <Segmented
              label="Agent"
              value={settings.agentTool}
              onChange={(agentTool) => updateSettings({ agentTool })}
              options={[
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex" },
                { value: "gemini", label: "Gemini CLI" },
              ]}
            />
          </Row>
        </>
      );

    case "updates":
      return (
        <>
          <Heading>Updates</Heading>
          <Lede>
            jterm checks for a new version in the background. With this on, one that can be
            installed without asking anything of you is installed straight away; it takes effect
            when you restart, and the restart always waits for you.
          </Lede>
          <Row label="Install updates automatically">
            <Toggle
              label="Install updates automatically"
              value={settings.autoUpdate}
              onChange={(autoUpdate) => updateSettings({ autoUpdate })}
            />
          </Row>
          <AppManagementCard />
        </>
      );
  }
}

/* ── App Management ─────────────────────────────────────────────────────── */

/**
 * Long enough that a check which answers instantly still reads as a check.
 * A spinner that flashes for one frame looks like a glitch, and after a
 * restart the whole point is to be seen looking.
 */
const MIN_CHECK_MS = 700;

/**
 * Whether macOS will let jterm replace itself, and how to make it — see
 * `permissions.rs`. Absent where the question does not arise: other
 * platforms, and a development build that is not running from a `.app`.
 */
function AppManagementCard() {
  const [status, setStatus] = useState<AppManagement | "checking">("checking");
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    let live = true;
    const started = Date.now();
    void permissions.appManagement().then(async (answer) => {
      const wait = MIN_CHECK_MS - (Date.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (live) setStatus(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  if (status === "notApplicable") return null;

  const restart = () => {
    rememberResume("updates");
    void updates.restart();
  };

  return (
    <section className="mt-5 border border-hairline-strong p-3">
      <div className="mb-1 text-[length:var(--fs-125)] text-ink-1">Permission to update itself</div>

      {status === "checking" ? (
        <p className="flex items-center gap-2 text-[length:var(--fs-11)] text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin text-ink-2" />
          Checking whether macOS lets jterm replace itself…
        </p>
      ) : status === "granted" ? (
        <p className="flex items-center gap-2 text-[length:var(--fs-11)] text-ink-2">
          {/* Fixed green rather than a theme colour: this is the one mark in
              the dialog that has to read as "done" in every palette, and
              some themes' greens are a long way from that. */}
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#30d158]">
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </span>
          macOS lets jterm update itself. Nothing to do here.
        </p>
      ) : status === "notWritable" ? (
        <p className="text-[length:var(--fs-11)] leading-relaxed text-ink-3">
          jterm.app is not this account&apos;s to change — it was installed by another user, or is
          running from the disk image. Drag it into Applications and open it from there, and it
          can update itself.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-[length:var(--fs-11)] leading-relaxed text-ink-3">
            macOS stops apps from changing apps — jterm included, when it installs its own update.
            Switch jterm.app on under <span className="text-ink-1">App Management</span>; macOS
            asks for Touch ID or your password. It takes effect when jterm restarts, and this
            step picks up again afterwards to check.
          </p>
          <AppManagementDemo />
          <p className="text-[length:var(--fs-10)] text-ink-4">
            Not in the list? Click + under it and choose jterm from Applications.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              onClick={() => {
                void permissions.openAppManagement();
                setOpened(true);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open App Management
            </Button>
            {/* Primary once the settings have been opened, because by then
                the restart is the next thing that has to happen. */}
            <button
              type="button"
              onClick={restart}
              className={cn(
                "px-3 py-1.5 text-[length:var(--fs-12)]",
                opened
                  ? "bg-brand text-brand-foreground hover:opacity-90"
                  : "border border-hairline-strong bg-surface-2 text-ink-1 hover:bg-surface-3",
              )}
            >
              I switched it on — restart jterm
            </button>
          </div>
          <p className="text-[length:var(--fs-10)] text-ink-4">
            Restarting brings your tabs back. Shells in tmux keep running; plain shells start
            fresh.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * A few seconds of System Settings: the pointer goes to jterm's switch, the
 * switch turns on, Touch ID asks. Pictures of the real window would be out of
 * date by the next macOS; this is just enough of it to recognise. The motion
 * is the `am-*` keyframes in `index.css`.
 */
function AppManagementDemo() {
  return (
    <div
      aria-hidden
      className="am-demo relative w-[280px] max-w-full select-none rounded-[10px] bg-[#f5f5f7] p-2 pb-3 text-[11px] text-[#1d1d1f] shadow-sm"
    >
      <div className="mb-1.5 text-[10px] text-[#6e6e73]">Privacy &amp; Security › App Management</div>
      <div className="flex items-center gap-2 rounded-[7px] bg-white px-2 py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-black text-[11px] font-bold text-[#f2cd6b]">
          J
        </span>
        <span className="flex-1">jterm.app</span>
        <span className="relative">
          <span className="am-track block h-[18px] w-[32px] rounded-full p-[2px]">
            <span className="am-thumb block h-[14px] w-[14px] rounded-full bg-white shadow" />
          </span>
          <MousePointer2 className="am-pointer absolute left-[16px] top-[9px] h-4 w-4 fill-white text-black" />
        </span>
      </div>
      <div className="am-touch absolute -bottom-3 right-2 flex items-center gap-1.5 rounded-[8px] bg-white px-2 py-1 shadow-md">
        <Fingerprint className="h-4 w-4 text-[#ff375f]" />
        <span>Touch ID to allow</span>
      </div>
    </div>
  );
}

function TmuxStep({
  probe,
  checking,
  onCheck,
  onInstall,
  backend,
}: {
  probe: SetupProbe | null;
  checking: boolean;
  onCheck: () => void;
  onInstall: (command: string) => void;
  backend: "direct" | "tmux";
}) {
  const offer = probe === null ? null : tmuxOffer(probe, platform());
  const checkAgain = (
    <Button onClick={onCheck} disabled={checking}>
      {checking ? "Checking…" : "Check again"}
    </Button>
  );

  return (
    <>
      <Heading>Shells that survive</Heading>
      <Lede>
        A plain shell dies with the app: if jterm crashes or you quit it, what comes back is a
        picture of what the shell printed. In a tmux session the shell itself keeps running — a
        build, an ssh, an agent halfway through a job — and jterm reattaches to it next time.
      </Lede>

      {offer === null ? (
        <p className="text-[length:var(--fs-11)] text-ink-3">Looking for tmux…</p>
      ) : offer.kind === "ready" ? (
        <div className="space-y-4">
          <p className="flex items-center gap-1.5 text-[length:var(--fs-11)] text-ink-2">
            <Check className="h-3.5 w-3.5 text-brand" />
            tmux is installed at <code className="font-mono text-ink-1">{offer.path}</code>
          </p>
          <Row
            label="New terminals run on"
            hint="Terminals that are already open stay as they are. New ones start in a tmux session of their own."
          >
            <Segmented
              label="New terminals run on"
              value={backend}
              onChange={(shellBackend) => updateSettings({ shellBackend })}
              options={[
                { value: "tmux", label: "A tmux session" },
                { value: "direct", label: "A shell" },
              ]}
            />
          </Row>
        </div>
      ) : offer.kind === "install" ? (
        <div className="space-y-3">
          <p className="text-[length:var(--fs-11)] text-ink-2">
            tmux is not installed. Homebrew can install it: this opens a tab with the command typed
            at the prompt, and you press Enter.
          </p>
          <code className="block bg-surface-2 px-2 py-1 font-mono text-[length:var(--fs-11)] text-ink-1">
            {offer.command}
          </code>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => onInstall(offer.command)}
              className="bg-brand px-3 py-1.5 text-[length:var(--fs-12)] text-brand-foreground hover:opacity-90"
            >
              Install tmux
            </button>
            {checkAgain}
          </div>
        </div>
      ) : offer.kind === "homebrew" ? (
        <div className="space-y-3">
          <p className="text-[length:var(--fs-11)] text-ink-2">
            tmux is not installed, and neither is Homebrew, the usual way to get it on a Mac.
            Install Homebrew from its site, then come back and check again — this step will offer
            to install tmux with it.
          </p>
          <div className="flex gap-1.5">
            <Button onClick={() => void openExternal(offer.url)}>
              <ExternalLink className="h-3.5 w-3.5" />
              brew.sh
            </Button>
            {checkAgain}
          </div>
        </div>
      ) : offer.kind === "manual" ? (
        <div className="space-y-3">
          <p className="text-[length:var(--fs-11)] text-ink-2">
            tmux is not installed. Install it with your package manager — usually one of these —
            then check again.
          </p>
          <code className="block whitespace-pre bg-surface-2 px-2 py-1 font-mono text-[length:var(--fs-11)] text-ink-1">
            {offer.commands.join("\n")}
          </code>
          {checkAgain}
        </div>
      ) : (
        <p className="text-[length:var(--fs-11)] text-ink-3">tmux is not available here.</p>
      )}
    </>
  );
}

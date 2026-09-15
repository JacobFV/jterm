/**
 * Settings → Updates: which version this is, whether there is a newer one, and
 * whether to take it without asking.
 *
 * The same store the titlebar badge reads — see `lib/updates.ts` — so pressing
 * Install here and watching the badge in the main window show the download are
 * the same event, not two views that happen to agree.
 */

import { useState } from "react";

import { checkForUpdates, installUpdate, restartToUpdate, useUpdates } from "@/lib/updates";
import { updateSettings } from "@/state/settings";
import { Button, Row, Section, Toggle } from "./controls";

export function UpdatesPanel({ autoUpdate }: { autoUpdate: boolean }) {
  const { state, progress } = useUpdates();
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    await checkForUpdates();
    setChecking(false);
  };

  const installLabel =
    state?.install === "password"
      ? "Install (asks for your password)"
      : state?.install === "quits"
        ? "Install and restart jterm"
        : "Install";

  let status: string;
  if (state === null) {
    status = "Asking the app which version it is…";
  } else if (state.unsupported !== null) {
    status = state.unsupported;
  } else if (state.installed !== null) {
    status = `Version ${state.installed} is installed. Restart jterm to start using it.`;
  } else if (state.installing) {
    status =
      progress?.total
        ? `Downloading version ${state.available?.version ?? ""}… ${Math.round((progress.downloaded / progress.total) * 100)}%`
        : "Installing…";
  } else if (state.available !== null) {
    status = `Version ${state.available.version} is available.`;
  } else {
    status = "No newer version has been found.";
  }

  const autoHint =
    state?.install === "password"
      ? "This copy was installed from a package, so installing needs your password: an update found in the background is offered in the titlebar rather than installed. A restart always waits for you."
      : state?.install === "quits"
        ? "On Windows the installer has to close jterm, so an update found in the background is offered in the titlebar rather than installed. A restart always waits for you."
        : "An update found in the background downloads and installs on its own, and waits for you to restart. A restart always waits for you — it restarts plain shells.";

  return (
    <Section title="Updates">
      <Row label={`jterm ${state?.current ?? ""}`} hint={state?.error ?? status}>
        <Button onClick={() => void check()} disabled={checking || state?.unsupported != null}>
          {checking ? "Checking…" : "Check now"}
        </Button>
      </Row>

      {state?.installed != null ? (
        <Row
          label="Restart to update"
          hint="Terminals on tmux keep running. Plain shells restart, and each pane comes back with its screen and an offer to resume what it was running."
        >
          <Button onClick={() => void restartToUpdate()}>Restart</Button>
        </Row>
      ) : state?.available != null && state.unsupported === null ? (
        <Row
          label={`Version ${state.available.version}`}
          hint={
            state.available.notes ? (
              <span className="whitespace-pre-wrap">{state.available.notes}</span>
            ) : undefined
          }
        >
          <Button onClick={() => void installUpdate()} disabled={state.installing}>
            {state.installing ? "Installing…" : installLabel}
          </Button>
        </Row>
      ) : null}

      <Row label="Install updates automatically" hint={autoHint}>
        <Toggle
          label="Install updates automatically"
          value={autoUpdate}
          onChange={(value) => updateSettings({ autoUpdate: value })}
        />
      </Row>
    </Section>
  );
}

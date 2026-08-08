import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { isSettingsRoute } from "./lib/settingsWindow";
import { initSettings } from "./state/settings";
import "./index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("no #root to mount into");

// Settings are read before anything is drawn. The theme is one of them, and a
// window that paints dark and then corrects itself to light a frame later is a
// worse first impression than one that waits for a file read nobody can see.
void initSettings().then(() => {
  // One bundle, two windows: the hash decides which. See `lib/settingsWindow.ts`.
  const root = isSettingsRoute() ? <SettingsWindow /> : <App />;

  // Deliberately not `StrictMode`. Its development-only double-invocation of
  // effects would spawn each pane's shell twice and leave the first orphaned,
  // which is a very confusing bug to chase for a check this app cannot benefit
  // from — every effect here already owns a real process or a native webview.
  createRoot(container).render(root);
});

import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("no #root to mount into");

// Deliberately not `StrictMode`. Its development-only double-invocation of
// effects would spawn each pane's shell twice and leave the first orphaned,
// which is a very confusing bug to chase for a check this app cannot benefit
// from — every effect here already owns a real process or a native webview.
createRoot(container).render(<App />);

/**
 * Where a render failure stops.
 *
 * React's default on an exception thrown during render is to unmount the whole
 * tree. In an app that is one window full of independent panes that is the
 * worst possible answer: a bug in one pane's render takes the tab strip, the
 * file tree and every other pane with it, and what the user sees is a blank
 * window — while behind it every shell is still running, still recording
 * scrollback, and now completely unreachable. The app is not gone, only its
 * face, and there is no way back to it but to quit and reopen.
 *
 * So the boundary goes around each pane. One pane's failure becomes one pane
 * showing what went wrong, next to siblings that never noticed, and the shells
 * behind all of them keep running. A second boundary sits at the root as the
 * backstop for the chrome itself, where the tree really is the app and the only
 * thing left to do is say so legibly rather than paint nothing.
 *
 * Deliberately without a "try again" button. A pane that threw on render will
 * almost always throw again on the next one — the state that caused it is still
 * there — and a button that visibly does nothing is worse than no button. The
 * pane's own menu can already replace it with a fresh one, which is the repair
 * that actually works.
 *
 * This catches *render* failures only. That is what React boundaries are for,
 * and it is worth being clear about the limit: an exception thrown inside an
 * event handler or an async callback does not pass through here. `lib/ptyBus`
 * guards the one place that matters most for those — the shared listener every
 * pane's output is delivered through.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Names the thing that failed, so the message can say which pane it was. */
  label?: string;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the only place with room for a component stack, and in a
    // Tauri build it is still reachable through the webview's inspector. The
    // point is that the failure leaves a record somewhere rather than being
    // swallowed by a boundary that only draws a nice message.
    console.error(`[jterm] ${this.props.label ?? "render"} failed`, error, info.componentStack);
  }

  render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;

    return (
      <div className="flex h-full w-full flex-col items-start gap-2 overflow-auto bg-surface-0 p-4">
        {/* One line, whatever the label is. A pane is named after its shell's
            prompt, which is routinely a full path and would otherwise wrap the
            heading onto three lines of tracked-out capitals. */}
        <p
          className="pane-title w-full truncate text-warn"
          title={this.props.label === undefined ? undefined : this.props.label}
        >
          {this.props.label === undefined ? "Render failed" : `${this.props.label} failed`}
        </p>
        <p className="text-[length:var(--fs-11)] text-ink-2">
          Something in this pane threw while drawing. Everything else in the
          window — including the shell behind this pane — is still running.
        </p>
        {/* The message verbatim, monospaced. Whoever reads this is going to
            paste it into a bug report, and a prettified one is a worse one. */}
        <pre className="max-w-full whitespace-pre-wrap break-words border border-border bg-surface-1 p-2 font-mono text-[length:var(--fs-10)] text-ink-3">
          {message}
        </pre>
      </div>
    );
  }
}

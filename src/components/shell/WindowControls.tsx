/**
 * Minimise / maximise / close for a window with no OS decorations.
 *
 * Not rendered on macOS, which keeps its native traffic lights — see
 * `lib/platform.ts`. On Windows and Linux the app owes the user replacements,
 * and they live at the far right of the tab strip.
 *
 * The maximise button is unusual, and the reason is Windows 11 Snap Layouts.
 * That flyout appears only when the OS hit-tests `HTMAXBUTTON`, so the backend
 * subclass reports this button's rectangle as non-client (see
 * `src-tauri/src/win32_snap.rs`). The cost is that the webview stops receiving
 * mouse events over it: `:hover` never fires and `onClick` never runs. So the
 * button publishes its bounds to the backend and paints hover from a native
 * event instead. On Linux none of that applies and the plain handlers act.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { usesNativeWindowChrome } from "@/lib/platform";

const HOVER_EVENT = "window-chrome://maximize-hover";

type AppWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (handler: () => void) => Promise<() => void>;
};

/**
 * Loaded lazily so the module graph does not pull `@tauri-apps/api/window` into
 * a browser build that can never use it.
 */
async function appWindow(): Promise<AppWindow | null> {
  if (!isTauri()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow() as unknown as AppWindow;
}

function ControlButton({
  title,
  onClick,
  danger = false,
  forcedHover = false,
  buttonRef,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  /** Paint hover from outside, for a button the OS hit-tests instead of us. */
  forcedHover?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      // Full-height hit targets: the strip is the titlebar, so these should be
      // as forgiving to hit as the system buttons they replace.
      className={cn(
        "inline-flex h-full w-11 items-center justify-center text-ink-3",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-surface-2 hover:text-ink-1",
        forcedHover && (danger ? "bg-danger text-white" : "bg-surface-2 text-ink-1"),
      )}
    >
      {children}
    </button>
  );
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [available, setAvailable] = useState(false);
  const [snapHover, setSnapHover] = useState(false);
  const maximizeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isTauri() || usesNativeWindowChrome()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const win = await appWindow();
      if (win === null || disposed) return;
      setAvailable(true);
      const sync = () => {
        void win.isMaximized().then((value) => {
          if (!disposed) setMaximized(value);
        });
      };
      sync();
      // The window can also be maximised by a double-click on the drag region
      // or a system shortcut, so the icon tracks the window rather than clicks.
      unlisten = await win.onResized(sync);
      if (disposed) unlisten();
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * Publish the maximise button's viewport rect so the backend can hit-test it.
   * Re-reported on every resize because the strip's contents move as tabs open.
   */
  const publishRect = useCallback(() => {
    const node = maximizeRef.current;
    if (node === null || !isTauri()) return;
    const rect = node.getBoundingClientRect();
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("set_maximize_button_rect", {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }).catch(() => {
        /* Non-Windows builds have nothing to do with this. */
      }),
    );
  }, []);

  useEffect(() => {
    if (!available) return;
    publishRect();
    const node = maximizeRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(publishRect);
    observer.observe(node);
    window.addEventListener("resize", publishRect);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishRect);
    };
  }, [available, publishRect]);

  // Hover state for a region the OS owns. Never arrives outside Windows.
  useEffect(() => {
    if (!available) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<boolean>(HOVER_EVENT, (event) => {
        if (!disposed) setSnapHover(event.payload === true);
      });
      if (disposed) stop();
      else unlisten = stop;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [available]);

  if (!available) return null;

  const act = (run: (win: AppWindow) => Promise<void>) => () => {
    void appWindow().then((win) => (win === null ? undefined : run(win)));
  };

  return (
    <div className="ml-1 flex shrink-0 items-stretch border-l border-border">
      <ControlButton title="Minimise" onClick={act((win) => win.minimize())}>
        <Minus className="h-3.5 w-3.5" />
      </ControlButton>
      <ControlButton
        title={maximized ? "Restore" : "Maximise"}
        onClick={act((win) => win.toggleMaximize())}
        forcedHover={snapHover}
        buttonRef={maximizeRef}
      >
        {maximized ? <Copy className="h-3 w-3 -scale-x-100" /> : <Square className="h-3 w-3" />}
      </ControlButton>
      <ControlButton title="Close" danger onClick={act((win) => win.close())}>
        <X className="h-3.5 w-3.5" />
      </ControlButton>
    </div>
  );
}

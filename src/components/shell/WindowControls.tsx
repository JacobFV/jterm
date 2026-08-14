/**
 * Minimise / maximise / close for a window with no OS decorations.
 *
 * Not rendered on macOS, which keeps its native traffic lights — see
 * `lib/platform.ts`. On Windows and Linux the app owes the user replacements,
 * and they live at the far right of the tab strip.
 *
 * Not rendered in fullscreen either, on any platform. These stand in for a
 * window frame, and a fullscreen window does not have one — every desktop hides
 * its own buttons there, macOS included, and an app that keeps drawing them is
 * offering to minimise something that is not in a stack of windows.
 *
 * The two platforms get genuinely different buttons, because their desktops
 * disagree about what a window button *is*. Windows draws full-height hit
 * targets with hairline glyphs and a red close. GNOME draws small circles with
 * a filled background, close included, and reserves red for the hover state.
 * Drawing the Windows shape on Linux is the single thing that makes an app look
 * most obviously foreign there, so this file branches rather than compromising.
 *
 * The maximise button is unusual on Windows, and the reason is Snap Layouts.
 * That flyout appears only when the OS hit-tests `HTMAXBUTTON`, so the backend
 * subclass reports this button's rectangle as non-client (see
 * `src-tauri/src/win32_snap.rs`). The cost is that the webview stops receiving
 * mouse events over it: `:hover` never fires and `onClick` never runs. So the
 * button publishes its bounds to the backend and paints hover from a native
 * event instead. On Linux none of that applies and the plain handlers act.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { isLinux, usesNativeWindowChrome } from "@/lib/platform";
import { useIsFullscreen } from "@/lib/useFullscreen";

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

/* ── Glyphs ──────────────────────────────────────────────────────────────── */

/**
 * Adwaita's symbolic set, traced rather than approximated with a generic icon
 * font. They are three strokes; getting them slightly wrong is exactly what
 * reads as "not a real GNOME app".
 */
function MinimiseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <path d="M4 9.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MaximiseGlyph({ maximized }: { maximized: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      {maximized ? (
        <>
          <rect x="3.2" y="5.2" width="7.6" height="7.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5.6 5.1V4.6A1.4 1.4 0 0 1 7 3.2h5.4A1.4 1.4 0 0 1 13.8 4.6V10a1.4 1.4 0 0 1-1.4 1.4h-.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      )}
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ── Buttons ─────────────────────────────────────────────────────────────── */

interface ButtonProps {
  title: string;
  onClick: () => void;
  danger?: boolean;
  /** Paint hover from outside, for a button the OS hit-tests instead of us. */
  forcedHover?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}

/** GNOME: a small filled circle, close included, red only on hover. */
function GtkButton({ title, onClick, danger = false, buttonRef, children }: ButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full",
        "bg-white/[0.08] text-ink-1 transition-colors",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-white/[0.16]",
      )}
    >
      {children}
    </button>
  );
}

/** Windows: full-height hit targets, no background until hover. */
function WinButton({ title, onClick, danger = false, forcedHover = false, buttonRef, children }: ButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
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

/**
 * `maximize` is not merely cosmetic on Windows.
 *
 * The maximise button publishes its rectangle to a single app-wide slot that
 * the main window's subclass hit-tests Snap Layouts against. A second window
 * drawing its own maximise button would overwrite that slot and move the main
 * window's snap region to wherever the second window's button happened to be.
 * The settings window therefore does without one — which is also what a window
 * of that shape wants anyway.
 */
export function WindowControls({ maximize = true }: { maximize?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const [available, setAvailable] = useState(false);
  const [snapHover, setSnapHover] = useState(false);
  const [gtk, setGtk] = useState(false);
  const maximizeRef = useRef<HTMLButtonElement | null>(null);
  // A fullscreen window has no frame to stand in for, so there is nothing for
  // these to replace. Leaving it fullscreen is the shortcut's job, or the
  // desktop's, and both still work with the buttons gone.
  const fullscreen = useIsFullscreen();
  const shown = available && !fullscreen;

  useEffect(() => {
    setGtk(isLinux());
  }, []);

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
   *
   * A zero-size rect is how the region is *given back*: the backend reads any
   * empty rectangle as "there is no button" and stops answering `HTMAXBUTTON`
   * there. That matters more than it sounds, because a claimed rectangle is
   * non-client and the webview receives no mouse events over it — a stale one
   * left behind after the button goes would be an invisible dead band across
   * the tab strip, on precisely the fullscreen window where the strip is all
   * there is.
   */
  const publishRect = useCallback(() => {
    if (!isTauri()) return;
    const rect = maximizeRef.current?.getBoundingClientRect();
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("set_maximize_button_rect", {
        x: rect?.left ?? 0,
        y: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      }).catch(() => {
        /* Non-Windows builds have nothing to do with this. */
      }),
    );
  }, []);

  useEffect(() => {
    // Only Windows hit-tests the button natively; on Linux publishing its
    // rectangle would be a message a minute for nobody to read.
    if (gtk || !maximize) return;

    // Gated on `shown` rather than `available`, and it runs either way: when
    // the button has gone the ref is already null, so this publishes the empty
    // rect that hands the region back.
    publishRect();
    const node = maximizeRef.current;
    if (!shown || node === null) return;

    const observer = new ResizeObserver(publishRect);
    observer.observe(node);
    window.addEventListener("resize", publishRect);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publishRect);
    };
  }, [shown, gtk, maximize, publishRect]);

  // Hover state for a region the OS owns. Never arrives outside Windows.
  useEffect(() => {
    if (!shown || gtk || !maximize) {
      // Nothing will send a leave for a button that stopped existing mid-hover.
      setSnapHover(false);
      return;
    }
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
  }, [shown, gtk, maximize]);

  if (!shown) return null;

  const act = (run: (win: AppWindow) => Promise<void>) => () => {
    void appWindow().then((win) => (win === null ? undefined : run(win)));
  };

  const Button = gtk ? GtkButton : WinButton;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center",
        gtk ? "gap-[9px] pl-3 pr-3.5" : "ml-1 items-stretch border-l border-border",
      )}
    >
      <Button title="Minimise" onClick={act((win) => win.minimize())}>
        <MinimiseGlyph />
      </Button>
      {maximize ? (
        <Button
          title={maximized ? "Restore" : "Maximise"}
          onClick={act((win) => win.toggleMaximize())}
          forcedHover={snapHover}
          buttonRef={maximizeRef}
        >
          <MaximiseGlyph maximized={maximized} />
        </Button>
      ) : null}
      <Button title="Close" danger onClick={act((win) => win.close())}>
        <CloseGlyph />
      </Button>
    </div>
  );
}

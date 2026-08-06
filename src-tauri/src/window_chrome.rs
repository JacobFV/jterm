//! Custom-titlebar plumbing.
//!
//! The tab strip *is* the titlebar, so the window runs without OS decorations
//! on Windows and Linux (macOS keeps its native traffic lights via
//! `titleBarStyle: Overlay`). Most of what the system used to provide is handed
//! back in the frontend — dragging, resize edges, the buttons themselves, all
//! in `components/shell/`. This module owns the one piece that needs native
//! code: Windows 11 Snap Layouts.

use parking_lot::RwLock;

/// Maximise-button bounds last reported by the frontend, in physical pixels
/// relative to the client area.
#[derive(Default)]
pub struct MaximizeButtonBounds {
    #[cfg_attr(not(windows), allow(dead_code))]
    rect: RwLock<Option<(i32, i32, i32, i32)>>,
}

impl MaximizeButtonBounds {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Report where the frontend drew its maximise button.
///
/// Coordinates arrive as CSS pixels relative to the viewport and are scaled
/// here, because the frontend has no reliable view of the client-area origin
/// and the scale factor can change when the window moves between monitors.
#[tauri::command]
pub fn set_maximize_button_rect(
    window: tauri::Window,
    state: tauri::State<'_, std::sync::Arc<MaximizeButtonBounds>>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let to_px = |value: f64| (value * scale).round() as i32;
    let next = if width > 0.0 && height > 0.0 {
        Some((to_px(x), to_px(y), to_px(x + width), to_px(y + height)))
    } else {
        None
    };
    *state.rect.write() = next;
    Ok(())
}

/* ── Windows ─────────────────────────────────────────────────────────────── */

#[cfg(windows)]
pub mod snap {
    use super::MaximizeButtonBounds;
    use crate::win32_snap::{attach, ButtonRect, SnapHooks};
    use std::sync::Arc;
    use tauri::{Emitter, Manager};

    /// Emitted when the OS hit-tests the maximise button, since the webview no
    /// longer receives mouse events over a non-client region.
    pub const HOVER_EVENT: &str = "window-chrome://maximize-hover";

    pub fn install(window: &tauri::WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let bounds = window.state::<Arc<MaximizeButtonBounds>>().inner().clone();

        let hover_window = window.clone();
        let toggle_window = window.clone();
        let hooks = SnapHooks {
            button_rect: Box::new(move || {
                bounds
                    .rect
                    .read()
                    .map(|(left, top, right, bottom)| ButtonRect {
                        left,
                        top,
                        right,
                        bottom,
                    })
            }),
            on_hover: Box::new(move |hovered| {
                let _ = hover_window.emit(HOVER_EVENT, hovered);
            }),
            on_toggle_maximize: Box::new(move || {
                let _ = toggle_window.is_maximized().map(|maximized| {
                    if maximized {
                        let _ = toggle_window.unmaximize();
                    } else {
                        let _ = toggle_window.maximize();
                    }
                });
            }),
        };

        // SAFETY: `hwnd` is this window's live handle and the subclass is
        // installed exactly once, during setup.
        unsafe {
            attach(hwnd.0 as isize, hooks);
        }
    }
}

#[cfg(not(windows))]
pub mod snap {
    /// No-op: Snap Layouts is a Windows 11 feature.
    pub fn install(_window: &tauri::WebviewWindow) {}
}

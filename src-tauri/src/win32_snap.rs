//! Windows 11 Snap Layouts for a window with a custom titlebar.
//!
//! Snap Layouts (the flyout offering half/quarter tiling) is driven entirely by
//! the OS: it appears when `WM_NCHITTEST` reports `HTMAXBUTTON` under the
//! cursor. A window that draws its own maximise button never reports that, so
//! the feature silently disappears — which is what removing the decorations
//! cost us.
//!
//! The fix is to subclass the window and answer `HTMAXBUTTON` for the rectangle
//! the frontend's maximise button occupies. That has a consequence worth
//! stating plainly: once a region is non-client, the webview stops receiving
//! mouse events over it. CSS `:hover` will not fire and React will never see
//! the click. So this module has to hand both back:
//!
//!   - hover enter/leave arrive as `WM_NCMOUSEMOVE` / `WM_NCMOUSELEAVE` and are
//!     forwarded to `on_hover`, which the frontend paints itself;
//!   - the click arrives as `WM_NCLBUTTONUP` and is forwarded to
//!     `on_toggle_maximize`.
//!
//! Deliberately free of any Tauri type so it can be compile-checked against the
//! Windows target in isolation; the Tauri glue lives in `window_chrome`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    HTCLIENT, HTMAXBUTTON, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE,
    WM_NCMOUSEMOVE,
};

/// Maximise-button bounds in *physical* pixels, relative to the client area.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ButtonRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ButtonRect {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }

    fn is_empty(&self) -> bool {
        self.right <= self.left || self.bottom <= self.top
    }
}

/// Everything the subclass needs from the outside world.
pub struct SnapHooks {
    /// Current button bounds, or `None` while the frontend has not reported one.
    pub button_rect: Box<dyn Fn() -> Option<ButtonRect> + Send + Sync>,
    /// Paint or clear the button's hover state.
    pub on_hover: Box<dyn Fn(bool) + Send + Sync>,
    /// The button was clicked.
    pub on_toggle_maximize: Box<dyn Fn() + Send + Sync>,
}

struct SnapState {
    hooks: SnapHooks,
    /// Whether we have an outstanding `TrackMouseEvent` leave subscription.
    tracking_leave: AtomicBool,
    /// Whether the frontend currently believes the button is hovered.
    hovered: AtomicBool,
}

const SUBCLASS_ID: usize = 0x7470_7001; // "tpp" + 1

fn loword_signed(value: isize) -> i32 {
    (value & 0xFFFF) as u16 as i16 as i32
}

fn hiword_signed(value: isize) -> i32 {
    ((value >> 16) & 0xFFFF) as u16 as i16 as i32
}

/// Attach the subclass to `hwnd`. Safe to call once per window.
///
/// # Safety
/// `hwnd` must be a live top-level window owned by this process.
pub unsafe fn attach(hwnd: isize, hooks: SnapHooks) -> bool {
    let state = Arc::new(SnapState {
        hooks,
        tracking_leave: AtomicBool::new(false),
        hovered: AtomicBool::new(false),
    });
    // Handed to the subclass as a raw pointer and never reclaimed: the subclass
    // lives exactly as long as the window, and the window outlives any point at
    // which freeing this would be observable.
    let raw = Arc::into_raw(state) as usize;
    unsafe {
        SetWindowSubclass(HWND(hwnd as *mut _), Some(subclass_proc), SUBCLASS_ID, raw).as_bool()
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    let state = unsafe { &*(data as *const SnapState) };

    match msg {
        WM_NCHITTEST => {
            let default = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            // Only ever *upgrade* a client hit. Anything the frame already
            // claims — a resize edge above all — keeps its answer, so this can
            // never eat a border grab.
            if default.0 != HTCLIENT as isize {
                return default;
            }
            let Some(rect) = (state.hooks.button_rect)() else {
                return default;
            };
            if rect.is_empty() {
                return default;
            }
            let mut point = POINT {
                x: loword_signed(lparam.0),
                y: hiword_signed(lparam.0),
            };
            if !unsafe { ScreenToClient(hwnd, &mut point) }.as_bool() {
                return default;
            }
            if rect.contains(point.x, point.y) {
                LRESULT(HTMAXBUTTON as isize)
            } else {
                default
            }
        }

        WM_NCMOUSEMOVE if wparam.0 as u32 == HTMAXBUTTON => {
            if !state.hovered.swap(true, Ordering::Relaxed) {
                (state.hooks.on_hover)(true);
            }
            if !state.tracking_leave.swap(true, Ordering::Relaxed) {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                if unsafe { TrackMouseEvent(&mut track) }.is_err() {
                    state.tracking_leave.store(false, Ordering::Relaxed);
                }
            }
            LRESULT(0)
        }

        // Any other non-client hover means the cursor left the button.
        WM_NCMOUSEMOVE | WM_NCMOUSELEAVE => {
            state.tracking_leave.store(false, Ordering::Relaxed);
            if state.hovered.swap(false, Ordering::Relaxed) {
                (state.hooks.on_hover)(false);
            }
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }

        // Swallow the press so the frame does not start its own caption-button
        // interaction; the release below is what acts.
        WM_NCLBUTTONDOWN if wparam.0 as u32 == HTMAXBUTTON => LRESULT(0),

        WM_NCLBUTTONUP if wparam.0 as u32 == HTMAXBUTTON => {
            if state.hovered.swap(false, Ordering::Relaxed) {
                (state.hooks.on_hover)(false);
            }
            (state.hooks.on_toggle_maximize)();
            LRESULT(0)
        }

        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

//! jterm — Tauri backend.
//!
//! One file per concern:
//!   - `files`         — reading and saving what editor panes have open
//!   - `pty`           — a pseudoterminal per terminal pane
//!   - `store`         — session snapshots and scrollback on disk
//!   - `window_chrome` — the native half of the custom titlebar
//!
//! Browser panes need nothing here: they are iframes, for reasons set out in
//! `src/panes/BrowserPane.tsx`. Opening a URL in the user's real browser is the
//! opener plugin's job.

pub mod files;
pub mod pty;
pub mod store;
#[cfg(windows)]
mod win32_snap;
pub mod window_chrome;

use std::path::PathBuf;
use std::sync::Arc;

use pty::PtyRegistry;
use store::Store;
use window_chrome::MaximizeButtonBounds;

/// Where session state lives, per platform convention:
/// `~/.local/share/jterm`, `~/Library/Application Support/…`,
/// `%APPDATA%\…`.
fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("jterm")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Store::open(data_dir());
    let registry = Arc::new(PtyRegistry::new());
    let maximize_bounds = Arc::new(MaximizeButtonBounds::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(store)
        .manage(registry)
        .manage(maximize_bounds)
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            store::session_save,
            store::session_load,
            store::session_dir,
            store::scrollback_read,
            store::scrollback_drop,
            store::scrollback_prune,
            files::file_read_text,
            files::file_write_text,
            window_chrome::set_maximize_button_rect,
        ])
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                window_chrome::snap::install(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running jterm");
}

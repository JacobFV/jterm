//! jterm — Tauri backend.
//!
//! One file per concern:
//!   - `agent_cli`     — starting the sidebar's agent with jterm's MCP server
//!   - `files`         — reading and saving what editor panes have open
//!   - `git`           — the sidebar's Git tab
//!   - `history`       — the JSONL every terminal leaves behind, and export/import
//!   - `isolation`     — keeping one tab's collapse away from the rest of the app
//!   - `mcp`           — the app's windows, offered to agents as MCP tools
//!   - `pty`           — a pseudoterminal per terminal pane
//!   - `recover`       — putting the window back when WebKit's renderer dies
//!   - `search`        — the sidebar's Search tab
//!   - `store`         — session snapshots and scrollback on disk
//!   - `updater`       — checking for, installing and restarting into a release
//!   - `window_chrome` — the native half of the custom titlebar
//!
//! Browser panes need nothing here: they are iframes, for reasons set out in
//! `src/panes/BrowserPane.tsx`. Opening a URL in the user's real browser is the
//! opener plugin's job.

pub mod agent_cli;
pub mod agents;
pub mod control;
pub mod files;
pub mod git;
pub mod history;
pub mod isolation;
pub mod mcp;
pub mod permissions;
pub mod programs;
pub mod pty;
pub mod rdp;
pub mod recover;
pub mod search;
pub mod sharing;
pub mod ssh;
pub mod store;
pub mod tmux;
pub mod updater;
pub mod vnc;
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
pub(crate) fn data_dir() -> PathBuf {
    dirs_next::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("jterm")
}

/// Leave a record of a panic where it can be found afterwards.
///
/// A panicking thread prints to stderr, and an app launched from a desktop
/// menu has no stderr anyone will ever read — which is how "it crashes
/// randomly" becomes a report with nothing attached to it. This appends the
/// same message to a file beside the session, so the next launch can be asked
/// what happened to the last one.
///
/// Kept to one file, appended to and never rotated: a panic here is rare
/// enough that the log is a handful of lines, and a rotation scheme would be
/// more machinery than the thing it manages. The default hook still runs, so
/// nothing that worked before stops working.
fn install_panic_log(root: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let where_ = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_else(|| "an unknown location".to_string());
        append_panic(
            &root,
            thread.name().unwrap_or("unnamed"),
            &where_,
            &info.to_string(),
        );
        previous(info);
    }));
}

/// Append one line about a panic, or give up quietly.
///
/// Split from the hook because a hook cannot be called in a test — there is no
/// way to construct the payload it is handed — while the part that can be wrong
/// is the sentence it builds.
fn append_panic(root: &std::path::Path, thread: &str, where_: &str, message: &str) {
    append_record(
        root,
        &format!("panicked in thread {thread} at {where_}: {message}"),
    );
}

/// Append one line to the record beside the session data, or give up quietly.
///
/// Everything that can actually go wrong is here: the directory, the open, the
/// write. Best effort throughout, since this is called from a panic hook and
/// from a crash handler, and one that could itself panic on a full disk would
/// turn a survivable failure into the abort all of this exists to avoid.
///
/// Kept to one file, appended to and never rotated. Both of the things that
/// write here are rare enough that the log is a handful of lines, and a
/// rotation scheme would be more machinery than the thing it manages. The name
/// is `panic.log` for the same reason the format leads with the version: the
/// next launch can be asked what happened to the last one, and it is the first
/// place anyone already looks.
pub(crate) fn append_record(root: &std::path::Path, line: &str) {
    use std::io::Write;
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("panic.log"))
    else {
        return;
    };
    let _ = writeln!(file, "jterm {} {line}", env!("CARGO_PKG_VERSION"));
}

/// The macOS menu bar: Tauri's stock one, less "Close Window".
///
/// The stock menu puts `Cmd+W` on Close Window, and a menu's key equivalent is
/// answered before the webview ever sees the press. So `Cmd+W` — which in every
/// tabbed app on the platform closes the tab — closed the whole window here,
/// shells and all, and no setting could stop it because the keymap never got a
/// look. With the item gone the press falls through to the page, where it
/// closes a pane (see `CLOSE_PANE` in `src/lib/keymap.ts`).
///
/// Built by hand rather than by taking the default and deleting from it: the
/// default's items are found only by their visible text, and a menu edited by
/// string match breaks quietly the first time that text changes. The red
/// button still closes a window, which is the gesture that should cost this
/// much.
#[cfg(target_os = "macos")]
fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            // Kept even though the page does its own copy and paste: these are
            // what make `Cmd+C`, `Cmd+V` and `Cmd+A` work in a plain text field,
            // which on macOS go through the responder chain, not the page.
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let root = data_dir();
    // Before anything that could panic, and before any thread exists to do it.
    let _ = std::fs::create_dir_all(&root);
    install_panic_log(root);

    let store = Store::open(data_dir());
    let registry = Arc::new(PtyRegistry::new());
    let control = Arc::new(control::ControlRegistry::new());
    let maximize_bounds = Arc::new(MaximizeButtonBounds::new());
    // Bound now, served once there are windows to hand tool calls to.
    let mcp_server = mcp::McpServer::bind();
    let mcp_serving = mcp_server.clone();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(updater::Updates::default()))
        .manage(store)
        .manage(registry)
        .manage(control)
        .manage(maximize_bounds)
        .manage(mcp_server)
        .manage(Arc::new(vnc::VncRegistry::default()))
        .manage(Arc::new(rdp::RdpRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn_agent,
            mcp::mcp_respond,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_diff,
            git::git_log,
            git::git_action,
            search::search_files,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_probe,
            pty::pty_foreground,
            pty::pty_attach,
            tmux::tmux_available,
            tmux::tmux_has_session,
            tmux::tmux_sessions,
            tmux::tmux_pane_command,
            tmux::tmux_kill_session,
            control::tmux_control_attach,
            control::tmux_control_detach,
            control::tmux_control_attached,
            control::tmux_control_pane_command,
            control::tmux_control_capture,
            ssh::ssh_tmux_sessions,
            ssh::ssh_hosts,
            ssh::ssh_jterm_layout,
            store::session_save,
            store::session_load,
            store::session_load_window,
            store::session_drop,
            store::session_windows,
            store::session_dir,
            store::recents_list,
            store::recents_push,
            store::recents_forget,
            store::settings_save,
            store::settings_load,
            store::scrollback_read,
            store::scrollback_drop,
            store::scrollback_prune,
            store::screen_save,
            store::restore_read,
            files::file_read_text,
            files::file_write_text,
            files::dir_list,
            files::dir_parent,
            files::dir_home,
            history::history_append,
            history::history_read,
            history::history_search,
            history::history_drop,
            history::history_prune,
            history::history_export,
            history::history_import,
            history::history_path,
            window_chrome::set_maximize_button_rect,
            programs::setup_probe,
            permissions::app_management_status,
            permissions::open_app_management,
            vnc::vnc_connect,
            vnc::vnc_send,
            vnc::vnc_close,
            rdp::rdp_connect,
            rdp::rdp_input,
            rdp::rdp_close,
            sharing::sharing_status,
            sharing::open_sharing_settings,
            updater::update_state,
            updater::update_check,
            updater::update_install,
            updater::update_restart,
        ])
        .setup(move |app| {
            use tauri::Manager;
            mcp_serving.serve(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                window_chrome::snap::install(&window);
                // Nothing is kept from this: the handler owns what it needs
                // and the webview owns the handler, for as long as both exist.
                recover::install(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A workspace window opened during the session needs the same two
            // hooks the main one is given in `setup`, and there is no "window
            // created" callback to hang them on. Its first focus is the
            // earliest moment the platform handle is certainly real, and
            // installing twice is not a problem: both hooks replace whatever
            // they had rather than stacking.
            if let tauri::WindowEvent::Focused(true) = event {
                use tauri::Manager;
                if window.label() != "main" && window.label() != "settings" {
                    if let Some(webview) = window.get_webview_window(window.label()) {
                        window_chrome::snap::install(&webview);
                        recover::install(&webview);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running jterm");
}

#[cfg(test)]
mod tests {
    use super::append_panic;

    /// A panic in one reader thread must leave a line behind and nothing else.
    /// The unwinding half of that — the process still being alive to write a
    /// second line — is what `panic = "abort"` used to take away.
    #[test]
    fn records_each_panic_without_losing_the_last_one() {
        let root = std::env::temp_dir().join(format!("jterm-panic-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("a temporary directory");

        append_panic(&root, "pty-reader", "src/pty.rs:42", "first");
        append_panic(&root, "tmux-control", "src/control.rs:7", "second");

        let log = std::fs::read_to_string(root.join("panic.log")).expect("a written log");
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2, "appended, not overwritten");
        assert!(lines[0].contains("pty-reader") && lines[0].contains("src/pty.rs:42"));
        assert!(lines[1].contains("tmux-control") && lines[1].contains("second"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// A directory that is not there is the case this must not make worse: the
    /// app is already panicking, and an unwritable log is not a second crash.
    #[test]
    fn stays_quiet_when_there_is_nowhere_to_write() {
        append_panic(
            std::path::Path::new("/jterm-does-not-exist-and-cannot-be-made"),
            "pty-reader",
            "src/pty.rs:1",
            "message",
        );
    }
}

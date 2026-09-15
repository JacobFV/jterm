//! jterm updating itself.
//!
//! Built on Tauri's updater plugin rather than beside it, because the part that
//! matters most is the part it already does properly: every download is checked
//! against a signature made with a key only the release workflow holds, so a
//! compromised mirror, a hijacked DNS answer or a tampered asset is refused
//! before anything is written. What this file adds is the policy around it.
//!
//! **How an update is installed depends on how jterm was.** The bundler stamps
//! the package type into the binary, and the plugin replaces what is there: an
//! AppImage rewrites its own file, macOS swaps the `.app`, Windows runs the new
//! installer (and quits to let it), and a `.deb` or `.rpm` is handed to the
//! package manager behind the desktop's password prompt. The frontend is told
//! which of those it is — `quiet`, `password` or `quits` — because they want
//! different buttons: only a quiet install is ever done without asking.
//!
//! **Nothing here restarts the app on its own.** Restarting ends every plain
//! shell in every pane. The crash-safety elsewhere puts their screens and their
//! agents back, but "your terminals will restart" is a decision for the person
//! using them, so an installed update waits for the Restart button.
//!
//! **Some copies cannot update themselves**, and say so rather than failing
//! halfway: a development build, a binary run from a tarball, or an AppImage
//! that has been extracted — each has nothing the plugin knows how to replace.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Raised to every window whenever the state below changes, so the settings
/// window and the badge in the main one never disagree.
pub const STATE_EVENT: &str = "update://state";
/// Raised per downloaded chunk while an update is on its way.
pub const PROGRESS_EVENT: &str = "update://progress";

/// What the app knows about updating, shared by every window.
#[derive(Default)]
pub struct Updates {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// The update the last check found, ready to download.
    pending: Option<Update>,
    installing: bool,
    /// A version already installed and waiting on a restart.
    installed: Option<String>,
    /// Why the last check or install failed, in words.
    error: Option<String>,
}

/// The state as a window sees it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    current: String,
    /// Why this copy cannot update itself; `None` when it can.
    unsupported: Option<String>,
    /// How installing goes here: `quiet`, `password` or `quits`.
    install: &'static str,
    available: Option<Available>,
    installing: bool,
    installed: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Available {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: usize,
    total: Option<u64>,
}

/// Why this copy of jterm has nothing to update, or `None` when it has.
fn unsupported() -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("This is a development build, which updates by being rebuilt.".into());
    }
    match bundle_type() {
        // An AppImage replaces its own file, and only knows which file that is
        // while it is being run as one.
        Some(BundleType::AppImage) if std::env::var_os("APPIMAGE").is_none() => {
            Some("This AppImage is not running from its own file, so there is nothing to replace.".into())
        }
        Some(_) => None,
        None => Some(
            "This copy was not installed from one of jterm's packages, so there is nothing for an update to replace."
                .into(),
        ),
    }
}

/// How an install behaves on this copy. See the module notes.
fn install_kind() -> &'static str {
    if cfg!(windows) {
        return "quits";
    }
    match bundle_type() {
        Some(BundleType::Deb) | Some(BundleType::Rpm) => "password",
        _ => "quiet",
    }
}

/// What to offer, given what a check found and what is already installed.
///
/// The plugin compares against the *running* version, which does not change
/// when an update is installed underneath it — so until the restart, every
/// check finds the version that is already on disk. Offering it again would ask
/// for a second download and, on Linux, a second password.
fn offer(found: Option<Available>, installed: Option<&str>) -> Option<Available> {
    found.filter(|available| Some(available.version.as_str()) != installed)
}

fn snapshot(app: &AppHandle, updates: &Updates) -> UpdateState {
    let inner = updates.inner.lock();
    let found = inner.pending.as_ref().map(|update| Available {
        version: update.version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    });
    UpdateState {
        current: app.package_info().version.to_string(),
        unsupported: unsupported(),
        install: install_kind(),
        available: offer(found, inner.installed.as_deref()),
        installing: inner.installing,
        installed: inner.installed.clone(),
        error: inner.error.clone(),
    }
}

/// Tell every window, and hand the same state back to the one that asked.
fn broadcast(app: &AppHandle, updates: &Updates) -> UpdateState {
    let state = snapshot(app, updates);
    let _ = app.emit(STATE_EVENT, state.clone());
    state
}

/// What is known without asking the network — for a window that just opened.
#[tauri::command]
pub fn update_state(app: AppHandle, updates: State<'_, Arc<Updates>>) -> UpdateState {
    snapshot(&app, &updates)
}

/// Ask the release feed whether there is something newer.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    updates: State<'_, Arc<Updates>>,
) -> Result<UpdateState, String> {
    if unsupported().is_some() {
        return Ok(snapshot(&app, &updates));
    }
    let found = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|err| err.to_string()),
        Err(err) => Err(err.to_string()),
    };
    {
        let mut inner = updates.inner.lock();
        match found {
            Ok(update) => {
                inner.pending = update;
                inner.error = None;
            }
            Err(err) => inner.error = Some(format!("Could not check for updates: {err}")),
        }
    }
    Ok(broadcast(&app, &updates))
}

/// Download the update the last check found, verify it, and install it.
///
/// The install runs on a blocking thread: a `.deb` sits waiting on a password
/// prompt for as long as the person takes to answer it, and every kind writes a
/// package's worth of bytes to disk. Neither belongs on the async runtime.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    updates: State<'_, Arc<Updates>>,
) -> Result<UpdateState, String> {
    let update = {
        let mut inner = updates.inner.lock();
        if inner.installing {
            return Err("An update is already being installed.".into());
        }
        let Some(update) = inner.pending.clone() else {
            return Err("There is no update to install yet.".into());
        };
        inner.installing = true;
        inner.error = None;
        update
    };
    broadcast(&app, &updates);

    let mut downloaded = 0usize;
    let result = match update
        .download(
            |chunk, total| {
                downloaded += chunk;
                let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await
    {
        Ok(bytes) => {
            let installer = update.clone();
            tauri::async_runtime::spawn_blocking(move || installer.install(bytes))
                .await
                .map_err(|err| err.to_string())
                .and_then(|installed| installed.map_err(|err| err.to_string()))
        }
        Err(err) => Err(err.to_string()),
    };

    {
        let mut inner = updates.inner.lock();
        inner.installing = false;
        match &result {
            Ok(()) => {
                inner.installed = Some(update.version.clone());
                inner.pending = None;
            }
            Err(err) => inner.error = Some(format!("The update did not install: {err}")),
        }
    }
    let state = broadcast(&app, &updates);
    result.map(|()| state)
}

/// Start the newly installed version. Only ever called from a button.
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{offer, Available};

    fn available(version: &str) -> Option<Available> {
        Some(Available {
            version: version.into(),
            notes: None,
            date: None,
        })
    }

    #[test]
    fn offers_what_a_check_found() {
        assert_eq!(offer(available("0.9.0"), None), available("0.9.0"));
        assert_eq!(offer(None, None), None);
    }

    #[test]
    fn does_not_offer_again_what_is_installed_and_waiting_on_a_restart() {
        assert_eq!(offer(available("0.9.0"), Some("0.9.0")), None);
        // Something newer again has come out since: that one is worth offering.
        assert_eq!(offer(available("0.9.1"), Some("0.9.0")), available("0.9.1"));
    }
}

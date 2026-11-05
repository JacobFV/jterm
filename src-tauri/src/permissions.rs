//! macOS's App Management permission, which is what lets jterm update itself.
//!
//! Since Ventura, an app may not modify another app's bundle — *including its
//! own* — unless it is signed by the same developer team as what it modifies,
//! or the user has switched it on under Privacy & Security → App Management.
//! jterm is ad-hoc signed, so it has no team, so the second is the only way:
//! without it the updater downloads a release, tries to swap the `.app`, and is
//! refused, and macOS shows a notification that most people dismiss unread.
//!
//! Two facts shape everything here:
//!
//!   - **There is no API to ask.** TCC's database is not readable by the app it
//!     describes. The only way to find out is to try: create a file inside the
//!     bundle and remove it again. That file exists for microseconds; nothing
//!     launches the bundle in between.
//!   - **The answer is fixed at launch.** Turning the switch on does not reach
//!     a process that is already running, so the welcome dialog asks for a
//!     restart and checks again afterwards. A check in the same run would keep
//!     saying "blocked" and make the switch look broken.
//!
//! A refusal from TCC is `EPERM`. A bundle the user simply cannot write — one
//! installed by an administrator into a root-owned `/Applications` — is
//! `EACCES`, and no switch fixes that, so it is reported separately rather than
//! sending someone to a setting that will not help.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppManagement {
    /// jterm can replace its own bundle.
    Granted,
    /// macOS is refusing: the switch is off, or was turned on after launch.
    Blocked,
    /// The bundle is not the user's to write, whatever macOS allows.
    NotWritable,
    /// Not a question here: another platform, or not running from a `.app`.
    NotApplicable,
}

/// Map the result of the probe write to an answer. Split out to be tested.
#[cfg(any(target_os = "macos", test))]
fn classify(result: std::io::Result<()>) -> AppManagement {
    match result {
        Ok(()) => AppManagement::Granted,
        // EPERM: TCC's refusal. EACCES: ordinary file permissions.
        Err(error) if error.raw_os_error() == Some(1) => AppManagement::Blocked,
        Err(error) if error.raw_os_error() == Some(13) => AppManagement::NotWritable,
        // Anything else — a read-only volume, a disk image still mounted — is
        // not something a setting can change either.
        Err(_) => AppManagement::NotWritable,
    }
}

#[cfg(target_os = "macos")]
fn bundle() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|dir| dir.extension().is_some_and(|ext| ext == "app"))
        .map(std::path::Path::to_path_buf)
}

#[tauri::command]
pub fn app_management_status() -> AppManagement {
    #[cfg(target_os = "macos")]
    {
        let Some(bundle) = bundle() else {
            return AppManagement::NotApplicable;
        };
        let probe = bundle.join("Contents").join(".jterm-update-probe");
        let result = std::fs::File::create(&probe).map(|_| ());
        if result.is_ok() {
            let _ = std::fs::remove_file(&probe);
        }
        classify(result)
    }
    #[cfg(not(target_os = "macos"))]
    {
        AppManagement::NotApplicable
    }
}

/// Open System Settings at the App Management list.
///
/// From here rather than through the opener plugin, which the page may only
/// use for web links — and widening that to every URL scheme so one fixed
/// address could be opened would be a poor trade.
#[tauri::command]
pub fn open_app_management() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles")
            .spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_refusal_from_a_bundle_that_is_not_yours() {
        assert_eq!(classify(Ok(())), AppManagement::Granted);
        assert_eq!(
            classify(Err(std::io::Error::from_raw_os_error(1))),
            AppManagement::Blocked
        );
        assert_eq!(
            classify(Err(std::io::Error::from_raw_os_error(13))),
            AppManagement::NotWritable
        );
        assert_eq!(
            classify(Err(std::io::Error::from_raw_os_error(30))),
            AppManagement::NotWritable
        );
    }
}

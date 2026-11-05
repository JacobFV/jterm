//! Finding a program the way the user's own shell would.
//!
//! An app opened from the Finder or the Dock does not inherit the `PATH` a
//! terminal has. launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
//! else, because `.zprofile` — where Homebrew puts itself — is read by login
//! shells and the Dock is not one. So a plain `PATH` walk from inside jterm
//! decides that tmux is not installed on a Mac where `which tmux` in any jterm
//! pane prints `/opt/homebrew/bin/tmux`, and the tmux backend, which is the
//! default, quietly becomes plain shells. Nothing says so; the shells simply
//! stop surviving the app.
//!
//! The answer here is to look where package managers put things after looking
//! where `PATH` says. After, so a program the user has deliberately put first
//! on their own `PATH` still wins. Asking a login shell for its `PATH` instead
//! would be more faithful and much slower — a shell's startup files can take
//! seconds, and can print, prompt or fail — for a question with five likely
//! answers.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Where package managers install things, in the order they are worth trying.
///
/// Homebrew on Apple silicon, then Homebrew on Intel (which is also where a
/// hand-built `make install` lands), MacPorts, Homebrew on Linux, and snaps.
/// The same list `ssh::EXTRA_PATH` appends for a remote machine's tmux, for the
/// same reason one hop further away.
pub const PACKAGE_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/snap/bin",
];

/// The first `name` on `PATH`, then in `PACKAGE_DIRS`.
pub fn find(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    find_in(name, std::env::split_paths(&path))
}

fn find_in(name: &str, path: impl Iterator<Item = PathBuf>) -> Option<PathBuf> {
    path.chain(PACKAGE_DIRS.iter().map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|candidate| is_program(candidate))
}

/// A file, rather than a directory of that name. Whether it is executable is
/// left for the attempt to run it to find out: a non-executable `tmux` on the
/// `PATH` is a broken install, and an error that says so is more use than one
/// that says tmux is missing.
fn is_program(candidate: &Path) -> bool {
    candidate.is_file()
}

/// What the welcome dialog needs to know to offer tmux honestly.
#[derive(Serialize)]
pub struct SetupProbe {
    /// Where tmux is, or `None` if it is not anywhere jterm can use it from —
    /// including everywhere on Windows, where `tmux::program` always says so.
    tmux: Option<String>,
    /// Where Homebrew is, which is what decides whether the dialog can offer
    /// to install tmux or can only say how. Only looked for on macOS: Homebrew
    /// on Linux exists, but somebody running it there has a package manager
    /// they would rather be told to use.
    brew: Option<String>,
}

#[tauri::command]
pub fn setup_probe() -> SetupProbe {
    let brew = if cfg!(target_os = "macos") {
        find("brew")
    } else {
        None
    };
    SetupProbe {
        tmux: crate::tmux::program().map(|path| path.to_string_lossy().into_owned()),
        brew: brew.map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_comes_before_the_package_directories() {
        let dir = std::env::temp_dir().join(format!("jterm-programs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("jterm-test-program"), "").unwrap();

        let found = find_in("jterm-test-program", vec![dir.clone()].into_iter());
        assert_eq!(found, Some(dir.join("jterm-test-program")));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_directory_is_not_a_program() {
        let dir = std::env::temp_dir().join(format!("jterm-programs-dir-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("jterm-not-a-program")).unwrap();

        assert_eq!(
            find_in("jterm-not-a-program", vec![dir.clone()].into_iter()),
            None
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nothing_found_is_none() {
        assert_eq!(
            find_in("jterm-certainly-not-installed", std::iter::empty()),
            None
        );
    }
}

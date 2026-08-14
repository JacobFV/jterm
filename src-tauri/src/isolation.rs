//! One cgroup per shell, so a tab that runs out of memory takes only itself.
//!
//! The failure this exists for is not a crash, which is what makes it such a
//! confusing one to be on the receiving end of. A tab running something large —
//! a build, a model, a language server that leaks — has that process killed by
//! the kernel's OOM killer, which is correct and by itself survivable. What is
//! not survivable is what happens next: every shell jterm spawns is, by
//! default, a member of the same systemd scope as jterm itself, and
//! `OOMPolicy=stop` (the default) means systemd answers *one member* being
//! OOM-killed by stopping *the whole unit*. The app and every other tab's shell
//! go with it. All the user sees is the window vanishing while they were
//! typing in a different tab, and all the journal says is
//! `Failed with result 'oom-kill'` about a process they never had open.
//!
//! So each shell is started through `systemd-run --scope`, which puts it in a
//! transient unit of its own before exec'ing it. The blast radius of the kill
//! becomes the one tab that earned it, and `OOMPolicy=continue` on that unit
//! narrows it again: the runaway child dies, and the shell that started it
//! stays, so the tab is still there to show what happened.
//!
//! `--scope` rather than `--service` is load-bearing. A scope is registered by
//! the process that is about to *become* it: systemd forks nothing, and the pid
//! jterm gets back from the spawn is still the shell's own. `pty_probe` reads
//! `/proc/<pid>/cwd` through that pid and `tmux::has_client` walks the process
//! table from it, and both would be looking at systemd's bookkeeping rather
//! than at a shell if this were a service.
//!
//! Everything here answers "no" off Linux — and on a Linux with no user service
//! manager to talk to — rather than being compiled away, so the caller has one
//! shape to deal with on all three platforms and simply finds the feature
//! switched off on two of them.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The `systemd-run` to start shells through, or `None` where that is not a
/// thing that can be done here.
///
/// Once rather than per spawn, for the same reason `tmux::program` is: the
/// answer cannot change inside a run in any way worth catching. It matters a
/// little more here, because this check is not a `PATH` walk — it is a round
/// trip to the service manager, and it would otherwise be on the path of every
/// new tab.
pub fn runner() -> Option<&'static PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND.get_or_init(locate).as_ref()
}

#[cfg(not(target_os = "linux"))]
fn locate() -> Option<PathBuf> {
    // cgroups, and the service manager that hands them out, are Linux's. macOS
    // and Windows have their own answers to resource limits and neither is
    // reachable from here.
    None
}

#[cfg(target_os = "linux")]
fn locate() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let binary = std::env::split_paths(&path)
        .map(|dir| dir.join("systemd-run"))
        .find(|candidate| candidate.is_file())?;

    // Installed is not the same as usable. `--user` needs a session manager to
    // register the scope with, and jterm can perfectly well be launched
    // somewhere there is none — inside a container, over ssh, from an init the
    // distribution chose instead. Finding that out here costs one transient
    // scope around `true`, about twenty milliseconds, once. Finding it out
    // later means a tab whose shell "exits" immediately with a line about
    // D-Bus where its prompt should be.
    let usable = std::process::Command::new(&binary)
        .args(["--user", "--scope", "--quiet", "--collect", "--", "true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success());

    usable.then_some(binary)
}

/// The arguments that go between `runner()` and the shell being wrapped.
///
/// Kept separate from the lookup so that the shape of the command is testable
/// without a service manager to run it against.
pub fn scope_args(id: &str) -> Vec<OsString> {
    vec![
        "--user".into(),
        "--scope".into(),
        // Nothing is going to read systemd-run's own chatter: the pty behind it
        // is the user's terminal, so a line about a transient scope would be
        // printed above their first prompt and stay in the scrollback for as
        // long as the tab lives.
        "--quiet".into(),
        // Forget the unit once it is empty. Without this, a scope whose shell
        // died in a way systemd considers a failure sits in `systemctl --user`
        // needing a reset — one entry per tab that ever went wrong.
        "--collect".into(),
        // Deliberately not `--unit=`. A name would have to be unique against
        // every scope still lingering, including one whose shell has exited but
        // whose disowned background job has not, and a collision does not
        // degrade — it fails the spawn, which is worse than the problem this
        // module is solving. `systemd-cgls` shows the description anyway.
        format!("--description=jterm pane {id}").into(),
        // The narrow form of the policy this whole module exists to get out
        // from under. Alone in its own scope a shell is no longer collateral
        // for other tabs, but it would still be stopped by systemd for the sin
        // of having started something the kernel later killed.
        "--property=OOMPolicy=continue".into(),
        // Everything after this is the shell and its arguments, whatever they
        // happen to begin with.
        "--".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::scope_args;

    #[test]
    fn hands_the_shell_over_after_a_bare_double_dash() {
        let args = scope_args("abc");
        assert_eq!(
            args.last().map(|arg| arg.to_string_lossy().into_owned()),
            Some("--".to_string()),
            "the shell's own argv must not be read as systemd-run's options"
        );
    }

    #[test]
    fn keeps_a_pane_findable_by_the_id_it_is_known_by() {
        let args = scope_args("abc");
        assert!(args.iter().any(|arg| arg == "--description=jterm pane abc"));
    }

    #[test]
    fn leaves_the_shell_standing_when_a_child_is_killed() {
        // The point of the exercise: `stop` here would put the tab back to
        // being collateral, just for a smaller blast.
        let args = scope_args("abc");
        assert!(args
            .iter()
            .any(|arg| arg == "--property=OOMPolicy=continue"));
    }
}

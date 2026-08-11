//! tmux, for the people who already live in it.
//!
//! Two quite different things live here, and keeping them apart is most of
//! understanding this file:
//!
//!   - **Sessions jterm starts.** With the tmux backend turned on, a new
//!     terminal is `tmux new-session -A` rather than a bare shell, so the
//!     process behind the pane outlives the app rather than dying with it. jterm
//!     then stops recording that pane's scrollback, because tmux is already
//!     keeping it and two copies of one history is not twice the safety.
//!   - **Sessions the user starts.** Someone typing `tmux attach` into an
//!     ordinary pane gets the same duplication without having asked for it, so
//!     `has_client` looks for a tmux client under the pane's shell and recording
//!     pauses for as long as one is there.
//!
//! None of this exists on Windows, where tmux does not. Every entry point
//! answers "no" there rather than being compiled away, so the frontend has one
//! shape to deal with on all three platforms and simply finds the feature
//! switched off on one of them.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

/// The tmux binary, looked up once.
///
/// Once rather than per call because the answer cannot change inside a run in
/// any way worth catching: a user who installs tmux while jterm is open gets it
/// on the next launch, and the alternative is a `PATH` walk on the way to every
/// keystroke that a tmux-backed pane forwards.
pub fn program() -> Option<&'static PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND.get_or_init(locate).as_ref()
}

/// The argv that puts a pane inside `session`, making it if it is not there.
///
/// `-A` is the whole trick: one command that attaches to an existing session
/// and creates it otherwise, so a restored pane finds the shell it left behind
/// and a pane whose machine has rebooted since quietly gets a new one. Neither
/// case needs asking about, which is why nothing above this has to know which
/// of the two happened.
///
/// `command` is passed only when the user has actually named a shell in
/// Settings. Left out, tmux starts its own `default-shell` through
/// `default-command` — which is how a tmux user's login shell, and whatever
/// they have configured around it, keeps working.
pub fn attach_argv(session: &str, cwd: &std::path::Path, command: Option<&str>) -> Vec<String> {
    let mut args = vec![
        // Force UTF-8 rather than letting tmux infer it from a locale that a
        // graphical app on macOS very often does not inherit.
        "-u".to_string(),
        "new-session".to_string(),
        "-A".to_string(),
        "-s".to_string(),
        session.to_string(),
        "-c".to_string(),
        cwd.to_string_lossy().into_owned(),
    ];
    if let Some(command) = command {
        args.push(command.to_string());
    }
    args
}

#[cfg(windows)]
fn locate() -> Option<PathBuf> {
    // tmux is a Unix program. There is a build for Cygwin and one inside WSL,
    // and neither can drive a ConPTY that this process owns, so claiming
    // support here would produce a setting that fails at the moment it is used.
    None
}

#[cfg(not(windows))]
fn locate() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("tmux"))
        .find(|candidate| candidate.is_file())
}

pub fn available() -> bool {
    program().is_some()
}

/// Run tmux and hand back its stdout, or `None` if it could not be run or said
/// it failed.
///
/// A failure is an ordinary outcome rather than an error worth surfacing: the
/// commonest one by far is "no server running on /tmp/tmux-1000/default", which
/// is what tmux says when there are simply no sessions yet.
fn run(args: &[&str]) -> Option<String> {
    let tmux = program()?;
    let output = Command::new(tmux).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/* ── Listing what is there ───────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct TmuxSession {
    pub name: String,
    pub windows: u32,
    /// Whether some client — this app or a terminal elsewhere — is looking at it.
    pub attached: bool,
}

/// Field separator for `list-sessions`.
///
/// A tab rather than the more usual colon or space, because a session name may
/// contain both and tmux will not stop anyone from choosing one that does.
const FIELDS: &str = "#{session_name}\t#{session_windows}\t#{session_attached}";

#[tauri::command]
pub fn tmux_available() -> bool {
    available()
}

#[tauri::command]
pub fn tmux_sessions() -> Vec<TmuxSession> {
    let Some(stdout) = run(&["list-sessions", "-F", FIELDS]) else {
        return Vec::new();
    };
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(TmuxSession {
                name,
                windows: parts.next().and_then(|n| n.parse().ok()).unwrap_or(1),
                attached: parts.next().is_some_and(|flag| flag == "1"),
            })
        })
        .collect()
}

/* ── Driving a session from jterm's own shortcuts ────────────────────────── */

/// The argv for a pane action, or `None` if the frontend asked for one that
/// does not exist.
///
/// A fixed table rather than passing arguments through from the frontend. The
/// frontend is ours, so this is not about defending against it — it is that
/// "run tmux with whatever the webview sent" is a shape worth not having, and
/// the set of things a pane shortcut can mean is closed anyway.
///
/// Every one targets the *session* rather than a pane id. tmux resolves that to
/// the session's current pane, which is exactly the one the user is looking at,
/// and it means jterm never has to track a pane id it does not own. It also
/// sidesteps the prefix entirely: the user may have rebound `C-b` to anything
/// at all, and none of this cares.
pub fn pane_argv(action: &str) -> Option<Vec<&'static str>> {
    Some(match action {
        // `-c` so a split opens where the pane it came from is, which is what
        // jterm's own splits do and what anyone splitting a shell expects.
        "split-right" => vec!["split-window", "-h", "-c", "#{pane_current_path}"],
        "split-down" => vec!["split-window", "-v", "-c", "#{pane_current_path}"],
        "close" => vec!["kill-pane"],
        "zoom" => vec!["resize-pane", "-Z"],
        "focus-left" => vec!["select-pane", "-L"],
        "focus-right" => vec!["select-pane", "-R"],
        "focus-up" => vec!["select-pane", "-U"],
        "focus-down" => vec!["select-pane", "-D"],
        "grow-left" => vec!["resize-pane", "-L"],
        "grow-right" => vec!["resize-pane", "-R"],
        "grow-up" => vec!["resize-pane", "-U"],
        "grow-down" => vec!["resize-pane", "-D"],
        _ => return None,
    })
}

fn argv(action: &str, session: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = pane_argv(action)?.into_iter().map(String::from).collect();
    out.push("-t".into());
    out.push(format!("{session}:"));
    Some(out)
}

/// The `#{pane_at_…}` flag that says a focus move has nowhere to go in tmux.
fn edge_for(action: &str) -> Option<&'static str> {
    match action {
        "focus-left" => Some("#{pane_at_left}"),
        "focus-right" => Some("#{pane_at_right}"),
        "focus-up" => Some("#{pane_at_top}"),
        "focus-down" => Some("#{pane_at_bottom}"),
        _ => None,
    }
}

/// Ask tmux to do to its own panes what the shortcut would have done to jterm's.
///
/// Returns whether tmux took it. `false` is not a failure — it is how moving
/// the focus off the edge of a tmux layout lands on the jterm pane next door
/// instead of doing nothing, which is the whole difference between the two
/// split trees feeling like one and feeling like a trap. `select-pane` cannot
/// report this itself: it exits 0 whether it moved or not, so the edge has to
/// be asked about first.
#[tauri::command]
pub fn tmux_pane_command(session: String, action: String) -> bool {
    let Some(args) = argv(&action, &session) else {
        return false;
    };

    if let Some(flag) = edge_for(&action) {
        let target = format!("{session}:");
        let at_edge = run(&["display-message", "-p", "-t", &target, flag])
            .map(|out| out.trim() == "1")
            // A session that will not answer is one this should not act on.
            .unwrap_or(true);
        if at_edge {
            return false;
        }
    }

    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&borrowed).is_some()
}

/// End a session jterm made for a pane that is now being closed.
///
/// Only ever called for jterm's own per-pane sessions — closing a pane that was
/// *attached* to someone's long-running `work` session must not destroy it, and
/// the frontend decides which is which from the name. See `lib/tmux.ts`.
///
/// This is what keeps the durability honest in both directions: quitting jterm,
/// or losing it, leaves every session running, while deliberately closing a pane
/// means the shell is finished with and takes its session with it.
#[tauri::command]
pub fn tmux_kill_session(session: String) {
    if session.is_empty() {
        return;
    }
    let target = format!("={session}");
    // Exact-match target (`=`): a prefix match here would kill a session that
    // merely starts with this name.
    let _ = run(&["kill-session", "-t", &target]);
}

/* ── Noticing a tmux the user started ────────────────────────────────────── */

/// Whether a tmux client is running under (or as) the process behind a pane.
///
/// Two cases, and both matter. `tmux attach` from the prompt makes a client
/// that is a child of the shell; `exec tmux` replaces the shell with one, so
/// the pane's own process *is* the client. Looking at the pid itself and its
/// direct children covers both, and going deeper would only start finding tmux
/// clients running inside other things, which is not what this question means.
#[cfg(target_os = "linux")]
pub fn has_client(pid: u32) -> bool {
    if is_tmux(pid) {
        return true;
    }
    let Ok(raw) = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")) else {
        return false;
    };
    raw.split_ascii_whitespace()
        .filter_map(|child| child.parse::<u32>().ok())
        .any(is_tmux)
}

#[cfg(target_os = "linux")]
fn is_tmux(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|name| is_tmux_name(name.trim()))
        .unwrap_or(false)
}

/// Whether a process name is tmux's.
///
/// Not simply `== "tmux"`. tmux renames itself once it knows what it is, so a
/// running client reports `tmux: client` and the server `tmux: server` — the
/// bare name only ever appears in the instant before it decides. The colon is
/// what keeps this from also matching `tmuxinator` and friends, which are
/// different programs that merely start with the same five letters.
///
/// Absent on Windows along with everything that calls it, where the question
/// cannot arise.
#[cfg(not(windows))]
fn is_tmux_name(name: &str) -> bool {
    name == "tmux" || name.starts_with("tmux:")
}

/// The same question on macOS, which has no `/proc` to ask.
///
/// `ps` is a process spawn, and this is called from a poll that runs per
/// visible pane — so the table is read at most a few times a second no matter
/// how many panes ask, and every pane in one poll shares a single answer.
#[cfg(target_os = "macos")]
pub fn has_client(pid: u32) -> bool {
    let table = process_table();
    if table.iter().any(|row| row.pid == pid && row.tmux) {
        return true;
    }
    table.iter().any(|row| row.parent == pid && row.tmux)
}

#[cfg(target_os = "macos")]
struct Process {
    pid: u32,
    parent: u32,
    tmux: bool,
}

#[cfg(target_os = "macos")]
const TABLE_TTL: std::time::Duration = std::time::Duration::from_millis(1200);

#[cfg(target_os = "macos")]
fn process_table() -> std::sync::Arc<Vec<Process>> {
    use std::time::Instant;
    static CACHE: OnceLock<parking_lot::Mutex<Option<(Instant, std::sync::Arc<Vec<Process>>)>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| parking_lot::Mutex::new(None));

    let mut held = cache.lock();
    if let Some((read_at, table)) = held.as_ref() {
        if read_at.elapsed() < TABLE_TTL {
            return table.clone();
        }
    }

    // Annotated because nothing else in this expression names the type: the
    // `unwrap_or_default()` at the end would happily be any `Default` collection,
    // and inference gives up. It compiles nowhere but macOS, so getting this
    // wrong is invisible until CI reaches the one platform that builds it.
    let rows: Vec<Process> = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|stdout| {
            stdout
                .lines()
                .filter_map(|line| {
                    let mut parts = line.split_ascii_whitespace();
                    let pid = parts.next()?.parse().ok()?;
                    let parent = parts.next()?.parse().ok()?;
                    // `comm` is a whole path here when the process has not
                    // renamed itself, and the renamed form when it has — so
                    // both the basename and the raw string are worth asking.
                    let command = parts.next().unwrap_or_default();
                    let name = command.rsplit('/').next().unwrap_or(command);
                    Some(Process {
                        pid,
                        parent,
                        tmux: is_tmux_name(name) || is_tmux_name(command),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let table = std::sync::Arc::new(rows);
    *held = Some((Instant::now(), table.clone()));
    table
}

#[cfg(windows)]
pub fn has_client(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{argv, attach_argv, edge_for};
    use std::path::Path;

    #[test]
    fn attaching_creates_the_session_if_it_is_not_there() {
        let args = attach_argv("work", Path::new("/tmp/x"), None);
        // `-A` is what makes one command cover both the restore and the first
        // launch; without it a reattach to a machine that has rebooted fails.
        assert!(args.contains(&"-A".to_string()));
        assert!(args.contains(&"work".to_string()));
        assert!(args.contains(&"/tmp/x".to_string()));
    }

    #[test]
    fn no_command_is_passed_unless_the_user_named_a_shell() {
        // Left out, tmux runs its own `default-shell` through `default-command`,
        // which is how a tmux user's login shell keeps working.
        let bare = attach_argv("work", Path::new("/tmp/x"), None);
        assert_eq!(bare.last().map(String::as_str), Some("/tmp/x"));

        let named = attach_argv("work", Path::new("/tmp/x"), Some("/bin/fish"));
        assert_eq!(named.last().map(String::as_str), Some("/bin/fish"));
    }

    #[test]
    #[cfg(not(windows))]
    fn recognises_tmux_by_the_name_it_gives_itself() {
        use super::is_tmux_name;
        // The forms a running tmux actually reports. Matching only "tmux" —
        // which is what this did at first — finds neither, and the pane goes on
        // recording a full-screen program's redraws into its scrollback.
        assert!(is_tmux_name("tmux: client"));
        assert!(is_tmux_name("tmux: server"));
        assert!(is_tmux_name("tmux"));
        // Different programs that merely start the same way.
        assert!(!is_tmux_name("tmuxinator"));
        assert!(!is_tmux_name("tmuxp"));
        assert!(!is_tmux_name("bash"));
    }

    #[test]
    fn only_focus_moves_ask_about_the_edge() {
        // The others have nothing to fall back to: growing a pane that has no
        // neighbour is a no-op in either split tree, so there is no boundary to
        // hand the keystroke across.
        assert_eq!(edge_for("focus-left"), Some("#{pane_at_left}"));
        assert_eq!(edge_for("focus-down"), Some("#{pane_at_bottom}"));
        assert!(edge_for("grow-left").is_none());
        assert!(edge_for("split-right").is_none());
        assert!(edge_for("zoom").is_none());
    }

    #[test]
    fn every_action_targets_the_session_it_was_given() {
        let args = argv("split-right", "jterm-abc").expect("split-right is a known action");
        assert_eq!(args.last().map(String::as_str), Some("jterm-abc:"));
        assert_eq!(args.first().map(String::as_str), Some("split-window"));
    }

    #[test]
    fn refuses_an_action_that_is_not_in_the_table() {
        // The frontend cannot ask for anything else, but the table is the thing
        // enforcing that rather than the caller's good manners.
        assert!(argv("kill-server", "jterm-abc").is_none());
        assert!(argv("", "jterm-abc").is_none());
    }

    #[test]
    fn a_session_name_is_anchored_with_a_colon() {
        // Without it, tmux reads the target as a prefix match and "work" would
        // happily resolve to "workshop" when the exact session is gone.
        let args = argv("zoom", "work").expect("zoom is a known action");
        assert!(args.contains(&"work:".to_string()));
    }
}

//! Another machine's tmux, reached over ssh.
//!
//! Control mode (see `crate::control`) does not care where its pty leads. Local
//! control mode runs `tmux -CC` on a pseudoterminal; remote control mode runs
//! `ssh -tt host 'tmux -CC …'` on one, and the lines that come back are the
//! same lines. So a remote host's windows become jterm tabs and its panes
//! become jterm panes by the same code, and this file is only the part that is
//! actually about ssh: finding it, saying which host, and quoting what is sent.
//!
//! ## Naming a remote session
//!
//! Everything above the backend — tabs, snapshot, the pane registry — knows a
//! control session by one string. A remote one is `host:session`. That is
//! unambiguous because tmux will not allow a `:` in a session name (it is
//! targeting syntax, and tmux rewrites it to `_`), so the *last* colon is always
//! the boundary, and a local session — which never has one — keeps exactly the
//! name it had before this existed. Nothing in an old snapshot changes meaning.
//!
//! ## Quoting, which is most of the risk
//!
//! ssh hands the remote command to the remote user's *login shell* as a single
//! string, and that shell may be bash, zsh or fish — which disagree about
//! almost every quoting rule except one: a single-quoted string with no single
//! quote inside it is literal in all of them. So everything is wrapped as
//! `sh -c '…'`, which gives a POSIX shell to write the rest for, and the few
//! characters that would break either layer are refused in a session name
//! rather than escaped. A host is held to the characters a hostname, an
//! `ssh_config` alias or a `user@` prefix can have, and may not begin with `-`,
//! which ssh would read as an option.
//!
//! Authentication is never interactive here: `BatchMode` makes a host that
//! would ask for a password fail at once with ssh's own message, rather than
//! leaving a prompt in a pty nobody can see. The panel offers a plain ssh
//! terminal for exactly that case, where the prompt can be answered.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

use crate::tmux::{self, TmuxSession};

/// The options every ssh this app runs is given.
///
/// - `BatchMode`: no password or host-key prompt — see the module comment.
/// - `ConnectTimeout`: a host that is off answers in seconds, not in the
///   minute or two of TCP's own patience.
/// - `ServerAlive*`: a link that dies quietly (a laptop lid, a Wi-Fi change)
///   is noticed within a minute and the session's tabs go, rather than
///   sitting there looking live and taking keystrokes into nothing.
const OPTIONS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];

/// Where tmux commonly lives that a non-interactive ssh's `PATH` leaves out.
///
/// A command run over ssh gets the login shell's non-interactive environment,
/// which on a Mac does not include Homebrew — so `tmux` is "not found" on a
/// machine where it plainly is. Appended rather than prepended, so a tmux the
/// user has put first on their own `PATH` still wins.
const EXTRA_PATH: &str =
    "/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/snap/bin";

/// Printed by the listing script when the far end has no tmux at all, so that
/// can be told apart from "tmux is there and has no sessions".
const NO_TMUX: &str = "__jterm_no_tmux__";

/// The ssh binary, looked up once — for the same reason as `tmux::program`.
pub fn program() -> Option<&'static PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND.get_or_init(locate).as_ref()
}

fn locate() -> Option<PathBuf> {
    let name = if cfg!(windows) { "ssh.exe" } else { "ssh" };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/* ── Names ───────────────────────────────────────────────────────────────── */

/// Split a control session's key into its host, if it has one, and the name
/// tmux knows the session by.
pub fn split_key(key: &str) -> (Option<&str>, &str) {
    match key.rsplit_once(':') {
        Some((host, name)) if !host.is_empty() => (Some(host), name),
        _ => (None, key),
    }
}

/// Whether `host` is something this will put on ssh's command line.
pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && !host.starts_with('-')
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '@'))
}

/// Whether a session name can be sent to the far end inside the quoting
/// described at the top of this file.
///
/// Refused: the single quote that would end the outer layer, the characters a
/// double-quoted POSIX string still interprets, and anything that is not
/// printable. Spaces and most punctuation are fine — tmux allows them and the
/// double quotes hold them together.
pub fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\'' | '"' | '$' | '`' | '\\' | '!'))
}

/* ── What is sent ────────────────────────────────────────────────────────── */

/// Wrap a POSIX shell script so any login shell runs it unchanged.
fn wrap(script: &str) -> String {
    // `script` is built only by this file, and nothing in it is a single quote.
    debug_assert!(!script.contains('\''));
    format!("sh -c 'PATH=\"$PATH:{EXTRA_PATH}\"; {script}'")
}

/// The remote command that puts a control client on `name`, creating the
/// session if it is not there — `new-session -A`, as for a local one.
pub fn control_command(name: &str, cols: u16, rows: u16) -> String {
    wrap(&format!(
        "exec tmux -CC -u new-session -A -s \"{name}\" -x {cols} -y {rows}"
    ))
}

/// The argv for an ssh carrying a control client: a forced tty, because
/// `-CC` turns echo off on one and wants one to turn it off on; and no escape
/// character, because a `~` at the start of a line is a keystroke a pane may
/// well send, and ssh would eat it.
pub fn control_argv(host: &str, name: &str, cols: u16, rows: u16) -> Vec<String> {
    let mut args: Vec<String> = OPTIONS.iter().map(|s| s.to_string()).collect();
    args.extend(["-tt", "-e", "none", "--", host].map(String::from));
    args.push(control_command(name, cols, rows));
    args
}

fn list_command() -> String {
    // The format is `tmux::FIELDS` — tabs between fields, which survive both
    // quoting layers as literal characters.
    wrap(&format!(
        "command -v tmux >/dev/null 2>&1 || {{ echo {NO_TMUX}; exit 0; }}; \
         tmux list-sessions -F \"{}\" 2>/dev/null; exit 0",
        tmux::FIELDS
    ))
}

/* ── Asking the far end ──────────────────────────────────────────────────── */

#[derive(Serialize)]
pub struct RemoteListing {
    /// Whether the host has tmux at all. Without it there is nothing to draw
    /// as panes, and the panel offers an ordinary ssh terminal instead.
    pub tmux: bool,
    pub sessions: Vec<TmuxSession>,
}

/// The tmux sessions on `host`.
///
/// An `Err` carries ssh's own last words — "Permission denied (publickey)",
/// "Could not resolve hostname" — because those say what to fix far better
/// than anything this could paraphrase them into.
///
/// Async, and the work on a blocking thread: an ssh that is waiting out a
/// connect timeout would otherwise be ten seconds of a frozen window.
#[tauri::command]
pub async fn ssh_tmux_sessions(host: String) -> Result<RemoteListing, String> {
    if !valid_host(&host) {
        return Err(format!("“{host}” is not a host name ssh can be given"));
    }
    let ssh = program().ok_or("ssh is not installed")?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(ssh)
            .args(OPTIONS)
            .args(["-T", "--", &host])
            .arg(list_command())
            .output()
            .map_err(|err| format!("could not run ssh: {err}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            return Err(last_words(&String::from_utf8_lossy(&output.stderr))
                .unwrap_or_else(|| format!("ssh to {host} failed")));
        }
        Ok(parse_listing(&stdout))
    })
    .await
    .map_err(|err| err.to_string())?
}

fn parse_listing(stdout: &str) -> RemoteListing {
    if stdout.lines().any(|line| line.trim() == NO_TMUX) {
        return RemoteListing {
            tmux: false,
            sessions: Vec::new(),
        };
    }
    RemoteListing {
        tmux: true,
        sessions: tmux::parse_sessions(stdout),
    }
}

/// The line of ssh's stderr worth showing: the last one that says anything.
///
/// ssh prefixes the real reason with warnings ("Warning: Permanently added…")
/// and the reason is reliably last.
pub fn last_words(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(String::from)
}

/// A machine the panel can offer, by the name the user knows it by.
#[derive(Serialize, Debug, PartialEq)]
pub struct SshHost {
    /// What to show: `gb10`.
    pub name: String,
    /// What to give ssh: `gb10` again for an `ssh_config` entry, or
    /// `me@10.0.0.7` for a shell alias.
    pub target: String,
}

/// The hosts this user already reaches by name, for the panel to suggest.
///
/// Two places, because people keep them in two places. `~/.ssh/config` is the
/// proper one and ssh reads it itself. But just as often a machine lives in a
/// shell alias — `alias ssh-gb10="ssh me@10.0.0.7"` — which ssh never sees,
/// and a GUI app never runs the shell that defines it. Reading the alias is
/// what lets `gb10` be offered as `gb10` rather than as an address the user
/// stopped remembering when they wrote the alias.
///
/// Only literal names in either: a `Host *.internal` pattern is a rule about
/// hosts, not a host, and an alias with options in it (`ssh -p 2222 …`) is not
/// one this could reproduce faithfully from the target alone, so it is left out
/// rather than offered as something that would connect somewhere else.
#[tauri::command]
pub fn ssh_hosts() -> Vec<SshHost> {
    let Some(home) = dirs_next::home_dir() else {
        return Vec::new();
    };
    let read = |path: PathBuf| std::fs::read_to_string(path).unwrap_or_default();
    let mut hosts: Vec<SshHost> = config_hosts(&read(home.join(".ssh").join("config")))
        .into_iter()
        .map(|name| SshHost {
            target: name.clone(),
            name,
        })
        .collect();
    for rc in [
        ".zshrc",
        ".bashrc",
        ".bash_aliases",
        ".bash_profile",
        ".profile",
    ] {
        for host in alias_hosts(&read(home.join(rc))) {
            if !hosts.iter().any(|known| known.name == host.name) {
                hosts.push(host);
            }
        }
    }
    hosts
}

/// `alias ssh-gb10="ssh me@10.0.0.7"` → `gb10` at `me@10.0.0.7`.
fn alias_hosts(text: &str) -> Vec<SshHost> {
    let mut hosts = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("alias ") else {
            continue;
        };
        let Some((name, value)) = rest.trim().split_once('=') else {
            continue;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        let mut words = value.split_whitespace();
        if words.next() != Some("ssh") {
            continue;
        }
        let (Some(target), None) = (words.next(), words.next()) else {
            continue;
        };
        if !valid_host(target) {
            continue;
        }
        // The alias's name is usually the machine's name with `ssh` stuck on
        // one end of it. Unstuck, it is what the user calls the machine.
        let short = name
            .strip_prefix("ssh-")
            .or_else(|| name.strip_prefix("ssh_"))
            .or_else(|| name.strip_suffix("-ssh"))
            .unwrap_or(name);
        if short.is_empty() || hosts.iter().any(|h: &SshHost| h.name == short) {
            continue;
        }
        hosts.push(SshHost {
            name: short.to_string(),
            target: target.to_string(),
        });
    }
    hosts
}

fn config_hosts(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let mut words = line.split_whitespace();
        let Some(keyword) = words.next() else {
            continue;
        };
        // `Host=name` is legal too, and so is any capitalisation.
        let (keyword, inline) = match keyword.split_once('=') {
            Some((key, value)) => (key, Some(value)),
            None => (keyword, None),
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        for name in inline.into_iter().chain(words) {
            let literal = !name.contains(['*', '?', '!']);
            if literal && valid_host(name) && !hosts.iter().any(|h| h == name) {
                hosts.push(name.to_string());
            }
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_with_a_colon_names_a_host() {
        assert_eq!(split_key("gb10:work"), (Some("gb10"), "work"));
        assert_eq!(
            split_key("me@gb10:jterm-ab12"),
            (Some("me@gb10"), "jterm-ab12")
        );
        // A local session — every key from before this existed — has no host.
        assert_eq!(split_key("work"), (None, "work"));
        assert_eq!(split_key(":work"), (None, ":work"));
    }

    #[test]
    fn a_host_cannot_be_an_option_or_carry_a_command() {
        assert!(valid_host("gb10"));
        assert!(valid_host("me@gb10.local"));
        assert!(valid_host("10.0.0.7"));
        assert!(!valid_host("-oProxyCommand=evil"));
        assert!(!valid_host("gb10; rm -rf ~"));
        assert!(!valid_host("gb10 other"));
        assert!(!valid_host(""));
    }

    #[test]
    fn a_name_that_would_escape_the_quoting_is_refused() {
        assert!(valid_remote_name("work"));
        assert!(valid_remote_name("my work"));
        assert!(valid_remote_name("jterm-ab12cd34"));
        for bad in ["a'b", "a\"b", "$(x)", "`x`", "a\\b", "a\nb", "a!b", ""] {
            assert!(!valid_remote_name(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn the_control_command_is_one_single_quoted_word() {
        let command = control_command("my work", 120, 40);
        assert!(command.starts_with("sh -c '"));
        assert!(command.ends_with('\''));
        // Exactly the two single quotes that open and close the outer layer.
        assert_eq!(command.matches('\'').count(), 2);
        assert!(command.contains("exec tmux -CC -u new-session -A -s \"my work\" -x 120 -y 40"));
    }

    #[test]
    fn the_host_comes_after_the_end_of_options() {
        let args = control_argv("gb10", "work", 80, 24);
        let dashes = args
            .iter()
            .position(|a| a == "--")
            .expect("an end of options");
        assert_eq!(args[dashes + 1], "gb10");
        assert_eq!(args.len(), dashes + 3);
        assert!(args.contains(&"-tt".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn the_list_command_survives_the_outer_quoting() {
        let command = list_command();
        assert_eq!(command.matches('\'').count(), 2);
        assert!(command.contains("#{session_name}"));
    }

    #[test]
    fn a_host_without_tmux_is_told_apart_from_one_with_no_sessions() {
        let none = parse_listing("__jterm_no_tmux__\n");
        assert!(!none.tmux);
        let empty = parse_listing("");
        assert!(empty.tmux);
        assert!(empty.sessions.is_empty());
        let some = parse_listing("work\t1\t0\t0\t/home/me\tbash\n");
        assert_eq!(some.sessions.len(), 1);
    }

    #[test]
    fn ssh_s_reason_is_its_last_line() {
        let stderr = "Warning: Permanently added 'x' to the list of known hosts.\r\n\
                      me@x: Permission denied (publickey).\r\n\n";
        assert_eq!(
            last_words(stderr).as_deref(),
            Some("me@x: Permission denied (publickey).")
        );
        assert_eq!(last_words(""), None);
    }

    #[test]
    fn config_hosts_are_the_literal_ones() {
        let config = "\
Host gb10
  HostName 192.168.1.40
host  pi  pi2
Host *.internal
Host=box
Host !bad dev-*
Host gb10
";
        assert_eq!(config_hosts(config), vec!["gb10", "pi", "pi2", "box"]);
    }

    #[test]
    fn a_shell_alias_names_a_machine() {
        let rc = r#"
alias ll="ls -la"
alias ssh-gb10="ssh me@10.32.0.5"
alias pi='ssh pi@raspberrypi.local'
alias tunnel="ssh -L 8080:localhost:80 me@box"
alias bad="ssh -oProxyCommand=x"
"#;
        assert_eq!(
            alias_hosts(rc),
            vec![
                SshHost {
                    name: "gb10".into(),
                    target: "me@10.32.0.5".into()
                },
                SshHost {
                    name: "pi".into(),
                    target: "pi@raspberrypi.local".into()
                },
            ]
        );
    }
}

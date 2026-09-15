//! What a pane is running, and the id it would need to be picked back up.
//!
//! A pane's last command line says what was *started* there, which is enough
//! for an icon and not enough to resume anything. `claude --continue` resumes
//! the most recent conversation in a directory, and a machine that went down
//! with four Claude tabs open in one repository has four candidates for "most
//! recent" and one answer for all of them. Resuming the right one needs the
//! conversation's own id, and the only thing that knows it is the running
//! process — so it is read off the process while it is still there, and the
//! frontend keeps it in the pane for the day it is not.
//!
//! Two questions, answered from `/proc`:
//!
//!   - **What is in the foreground.** A terminal has exactly one foreground
//!     process group, and the kernel says which on every process attached to
//!     it (`tpgid` in `stat`). Asking the shell is enough: when it equals the
//!     shell's own pid, the shell is at its prompt and nothing is running.
//!   - **Which conversation.** Each agent leaves the answer somewhere different.
//!     Claude Code writes `sessions/<pid>.json` into its config directory for
//!     as long as it runs, carrying the session id and the process start time
//!     it belongs to. Codex holds its transcript open, and the transcript's
//!     name ends in the id. Gemini leaves nothing tied to a process, so it gets
//!     no id and the frontend falls back to its "latest in this directory".
//!
//! Linux only. Elsewhere there is no `/proc` to ask, the answer is always
//! "nothing known", and the frontend treats that as it treats an agent with no
//! id: it offers the less precise resume.

use serde::Serialize;

/// The program in the foreground of a pane's terminal.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Foreground {
    /// Which agent this is, by the id `lib/programs.ts` knows it by — or `None`
    /// for anything that is not one of the agents below.
    pub tool: Option<String>,
    /// What it was started as, without its path: `claude`, `cargo`, `vim`.
    pub name: String,
    /// The agent's own id for the conversation, when the process gives it away.
    pub session: Option<String>,
    /// Where the agent is running, which is where a resume has to run too:
    /// every one of them files its conversations by directory.
    pub cwd: Option<String>,
    /// The agent's own arguments, after its name — empty for anything that is
    /// not an agent.
    ///
    /// Read off the process rather than the command line typed at the prompt,
    /// because the process has them after the shell has finished with quoting.
    /// What a resume needs from them is the flags: a Claude started with
    /// `--dangerously-skip-permissions` and resumed without it is a different
    /// session to work in. Which flags are worth carrying is the frontend's
    /// call — see `resumeFlags` in `lib/agents.ts` — so all of them are sent.
    pub args: Vec<String>,
}

/// What is running in the terminal `root` is attached to, if anything is.
///
/// `root` is the shell — for a tmux-backed pane, the shell inside tmux, since
/// jterm's own pty only ever has a tmux client in front of it.
#[cfg(target_os = "linux")]
pub fn foreground(root: u32) -> Option<Foreground> {
    linux::foreground(root)
}

#[cfg(not(target_os = "linux"))]
pub fn foreground(_root: u32) -> Option<Foreground> {
    None
}

/// The agents this knows how to recognise, by the id `lib/programs.ts` uses.
///
/// Matched on the program's name rather than its path, and generously: Codex
/// installed through npm is a Node script that starts a native binary named for
/// its target triple (`codex-x86_64-unknown-linux-musl`), and both of those are
/// Codex.
#[cfg(any(target_os = "linux", test))]
fn tool_for(name: &str) -> Option<&'static str> {
    const TOOLS: [&str; 3] = ["claude", "codex", "gemini"];
    TOOLS.into_iter().find(|tool| {
        name == *tool
            || name
                .strip_prefix(tool)
                .is_some_and(|rest| rest.starts_with('-') || rest.starts_with('.'))
    })
}

/// The name a process was started as.
///
/// An interpreter is looked through to the script it is running: `node
/// /usr/lib/node_modules/@google/gemini-cli/dist/index.js` is not usefully
/// called `node`, and `node …/bin/gemini` is Gemini. Only one level — anything
/// deeper is guessing about somebody's launcher.
#[cfg(any(target_os = "linux", test))]
fn program_name(argv: &[String]) -> Option<String> {
    let base = |word: &str| word.rsplit('/').next().unwrap_or(word).to_string();
    let first = base(argv.first()?);
    if matches!(first.as_str(), "node" | "nodejs" | "bun" | "deno") {
        if let Some(script) = argv.iter().skip(1).find(|word| !word.starts_with('-')) {
            let script = base(script);
            let stem = [".js", ".mjs", ".cjs", ".ts"]
                .iter()
                .find_map(|ext| script.strip_suffix(ext))
                .unwrap_or(&script);
            return Some(stem.to_string());
        }
    }
    Some(first)
}

/// The arguments after the program itself, looking through an interpreter the
/// way `program_name` does.
///
/// Capped in count and length: this goes over IPC and into the snapshot, and a
/// prompt pasted onto a command line can be any size at all.
#[cfg(any(target_os = "linux", test))]
fn arguments(argv: &[String]) -> Vec<String> {
    const MAX_ARGS: usize = 64;
    const MAX_ARG: usize = 512;
    let base = |word: &str| word.rsplit('/').next().unwrap_or(word).to_string();
    let Some(first) = argv.first() else {
        return Vec::new();
    };
    let start = if matches!(base(first).as_str(), "node" | "nodejs" | "bun" | "deno") {
        argv.iter()
            .skip(1)
            .position(|word| !word.starts_with('-'))
            .map_or(argv.len(), |index| index + 2)
    } else {
        1
    };
    argv.iter()
        .skip(start)
        .filter(|arg| arg.len() <= MAX_ARG)
        .take(MAX_ARGS)
        .cloned()
        .collect()
}

/// `tpgid` and `starttime` out of `/proc/<pid>/stat`.
///
/// The process name is the second field and may contain spaces and
/// parentheses — tmux calls itself `tmux: client` — so the fields are counted
/// from the *last* closing parenthesis rather than split from the start.
#[cfg(any(target_os = "linux", test))]
fn parse_stat(text: &str) -> Option<(i64, u64)> {
    let rest = &text[text.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_ascii_whitespace().collect();
    // Counting from `state`, the first field after the name: `tpgid` is the
    // sixth and `starttime` the twentieth.
    let tpgid = fields.get(5)?.parse().ok()?;
    let starttime = fields.get(19)?.parse().ok()?;
    Some((tpgid, starttime))
}

/// An id that is safe to hand to a command line and to keep in the snapshot.
///
/// Every agent's ids are UUIDs or close to them. Anything else is refused
/// rather than cleaned, because it is about to be typed into a shell.
#[cfg(any(target_os = "linux", test))]
fn valid_session(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

/// The session id in Claude Code's `sessions/<pid>.json`, if it is this process's.
///
/// The file is written for as long as Claude runs and removed when it exits —
/// but not when it is killed, and pids are reused. So it is only believed when
/// it names the pid *and* the start time of the process being asked about;
/// otherwise it belongs to an earlier process that happened to have the same
/// number.
#[cfg(any(target_os = "linux", test))]
fn claude_session(json: &str, pid: u32, starttime: u64) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    if value.get("pid")?.as_u64()? != u64::from(pid) {
        return None;
    }
    if let Some(started) = value.get("procStart") {
        if started.as_str()? != starttime.to_string() {
            return None;
        }
    }
    let id = value.get("sessionId")?.as_str()?;
    valid_session(id).then(|| id.to_string())
}

/// The session id in the name of a transcript Codex has open.
///
/// `…/sessions/2026/09/08/rollout-2026-09-08T19-15-48-<uuid>.jsonl`: the id is
/// the UUID the name ends with, which is what `codex resume <id>` takes.
#[cfg(any(target_os = "linux", test))]
fn codex_session(path: &str) -> Option<String> {
    if !path.contains("/sessions/") {
        return None;
    }
    let name = path.rsplit('/').next()?;
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    let shaped = id.chars().enumerate().all(|(index, ch)| match index {
        8 | 13 | 18 | 23 => ch == '-',
        _ => ch.is_ascii_hexdigit(),
    });
    (shaped && valid_session(id)).then(|| id.to_string())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fs;
    use std::path::PathBuf;

    use super::{
        arguments, claude_session, codex_session, parse_stat, program_name, tool_for, Foreground,
    };

    /// How far below the foreground process an agent is looked for. `npx
    /// claude` puts npm in front of it, and Codex's npm launcher puts Node in
    /// front of the real binary; two levels covers both without starting to
    /// find agents that some other program happens to be running.
    const DEPTH: usize = 2;

    pub fn foreground(root: u32) -> Option<Foreground> {
        let (tpgid, _) = stat(root)?;
        // At its prompt the shell is its own foreground, and a non-positive
        // group means the terminal has none — neither has anything running.
        let leader = u32::try_from(tpgid)
            .ok()
            .filter(|&pid| pid != 0 && pid != root)?;
        let name = program_name(&argv(leader)?)?;

        let Some((pid, tool)) = find_agent(leader, 0) else {
            return Some(Foreground {
                tool: None,
                name,
                session: None,
                cwd: cwd(leader),
                args: Vec::new(),
            });
        };
        let session = match tool {
            "claude" => claude(pid),
            "codex" => codex(pid, 0),
            _ => None,
        };
        Some(Foreground {
            tool: Some(tool.to_string()),
            name,
            session,
            cwd: cwd(pid),
            args: argv(pid).map(|argv| arguments(&argv)).unwrap_or_default(),
        })
    }

    fn find_agent(pid: u32, depth: usize) -> Option<(u32, &'static str)> {
        if let Some(tool) = argv(pid)
            .as_deref()
            .and_then(program_name)
            .as_deref()
            .and_then(tool_for)
        {
            return Some((pid, tool));
        }
        if depth >= DEPTH {
            return None;
        }
        children(pid)
            .into_iter()
            .find_map(|child| find_agent(child, depth + 1))
    }

    fn claude(pid: u32) -> Option<String> {
        let (_, starttime) = stat(pid)?;
        // Claude honours `CLAUDE_CONFIG_DIR`, and the file is under whichever
        // directory *that process* was told to use — not this one's.
        let dir = env(pid, "CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs_next::home_dir().map(|home| home.join(".claude")))?;
        let json = fs::read_to_string(dir.join("sessions").join(format!("{pid}.json"))).ok()?;
        claude_session(&json, pid, starttime)
    }

    /// The transcript is held by whichever process writes it, which under the
    /// npm launcher is the child rather than the process that was started.
    fn codex(pid: u32, depth: usize) -> Option<String> {
        let held = fs::read_dir(format!("/proc/{pid}/fd"))
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .find_map(|target| codex_session(&target.to_string_lossy()));
        if held.is_some() || depth >= super::linux::DEPTH {
            return held;
        }
        children(pid)
            .into_iter()
            .find_map(|child| codex(child, depth + 1))
    }

    fn stat(pid: u32) -> Option<(i64, u64)> {
        parse_stat(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
    }

    fn argv(pid: u32) -> Option<Vec<String>> {
        let raw = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let words: Vec<String> = raw
            .split(|byte| *byte == 0)
            .filter(|word| !word.is_empty())
            .map(|word| String::from_utf8_lossy(word).into_owned())
            .collect();
        (!words.is_empty()).then_some(words)
    }

    fn cwd(pid: u32) -> Option<String> {
        fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn children(pid: u32) -> Vec<u32> {
        fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
            .map(|raw| {
                raw.split_ascii_whitespace()
                    .filter_map(|child| child.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn env(pid: u32, name: &str) -> Option<String> {
        let raw = fs::read(format!("/proc/{pid}/environ")).ok()?;
        let prefix = format!("{name}=");
        raw.split(|byte| *byte == 0)
            .filter_map(|entry| std::str::from_utf8(entry).ok())
            .find_map(|entry| entry.strip_prefix(&prefix).map(str::to_string))
            .filter(|value| !value.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &str) -> Vec<String> {
        line.split(' ').map(String::from).collect()
    }

    #[test]
    fn recognises_each_agent_however_it_was_installed() {
        assert_eq!(tool_for("claude"), Some("claude"));
        assert_eq!(tool_for("codex"), Some("codex"));
        // The native binary Codex's npm launcher starts.
        assert_eq!(tool_for("codex-x86_64-unknown-linux-musl"), Some("codex"));
        assert_eq!(tool_for("gemini"), Some("gemini"));
        // Programs that merely start with the same letters.
        assert_eq!(tool_for("claudette"), None);
        assert_eq!(tool_for("codexify"), None);
        assert_eq!(tool_for("bash"), None);
    }

    #[test]
    fn names_a_script_after_itself_rather_than_its_interpreter() {
        assert_eq!(
            program_name(&words("/usr/bin/node /usr/bin/gemini")).as_deref(),
            Some("gemini")
        );
        assert_eq!(
            program_name(&words("node --no-warnings /opt/codex/bin/codex.js")).as_deref(),
            Some("codex")
        );
        assert_eq!(
            program_name(&words("/home/u/.local/bin/claude --resume")).as_deref(),
            Some("claude")
        );
        assert_eq!(
            program_name(&words("cargo build")).as_deref(),
            Some("cargo")
        );
        assert_eq!(program_name(&[]), None);
    }

    #[test]
    fn takes_the_arguments_after_the_program_or_its_script() {
        assert_eq!(
            arguments(&words(
                "/home/u/.local/bin/claude --dangerously-skip-permissions"
            )),
            words("--dangerously-skip-permissions")
        );
        assert_eq!(
            arguments(&words("node --no-warnings /usr/bin/gemini --yolo -m flash")),
            words("--yolo -m flash")
        );
        assert!(arguments(&words("codex")).is_empty());
        assert!(arguments(&[]).is_empty());
        // A pasted prompt the size of a file is not carried anywhere.
        let huge = vec![
            "claude".to_string(),
            "x".repeat(10_000),
            "--verbose".to_string(),
        ];
        assert_eq!(arguments(&huge), words("--verbose"));
    }

    #[test]
    fn reads_stat_past_a_name_with_spaces_and_parentheses() {
        let line = "4242 (tmux: client (x)) S 1 4242 4242 34817 5151 4194560 \
                    1 2 3 4 5 6 7 8 20 0 1 0 38918 1000 200";
        assert_eq!(parse_stat(line), Some((5151, 38918)));
        assert_eq!(parse_stat("garbage"), None);
    }

    const SESSION: &str = "8155b3bc-1a64-47e9-8c56-db7c2664a5e6";

    #[test]
    fn believes_claudes_session_file_only_for_the_process_it_names() {
        let json = format!(r#"{{"pid":51328,"procStart":"38918","sessionId":"{SESSION}"}}"#);
        assert_eq!(
            claude_session(&json, 51328, 38918).as_deref(),
            Some(SESSION)
        );
        // Same pid, a different process: the file outlived a Claude that was
        // killed, and the number has been handed out again since.
        assert_eq!(claude_session(&json, 51328, 99999), None);
        assert_eq!(claude_session(&json, 1, 38918), None);
        assert_eq!(claude_session("not json", 51328, 38918), None);
    }

    #[test]
    fn refuses_a_session_id_that_is_not_safe_to_type() {
        let json = r#"{"pid":7,"procStart":"1","sessionId":"x; rm -rf ~"}"#;
        assert_eq!(claude_session(json, 7, 1), None);
    }

    #[test]
    fn takes_codexs_session_id_from_its_transcript_name() {
        let path = "/home/u/.codex/sessions/2026/09/08/\
                    rollout-2026-09-08T19-15-48-01a083f3-311b-7972-be04-48c6747a82de.jsonl";
        assert_eq!(
            codex_session(path).as_deref(),
            Some("01a083f3-311b-7972-be04-48c6747a82de")
        );
        assert_eq!(codex_session("/home/u/notes/rollout-plan.jsonl"), None);
        assert_eq!(
            codex_session("/home/u/.codex/sessions/2026/09/08/history.jsonl"),
            None
        );
    }
}

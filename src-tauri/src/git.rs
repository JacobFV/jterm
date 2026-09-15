//! The sidebar's Git tab: what has changed, and the handful of things you do
//! about it without leaving the window.
//!
//! Everything goes through the `git` binary rather than a library. The user's
//! git is the one that already knows their credential helpers, their hooks,
//! their `safe.directory` list and whatever `core.fsmonitor` they set up — a
//! reimplementation would disagree with the terminal next to it about what the
//! repository looks like, which is the one thing this tab must never do.
//!
//! Three settings on every invocation, each for a failure that is otherwise
//! silent:
//!
//!   - `GIT_TERMINAL_PROMPT=0`. There is no terminal behind these processes. A
//!     push that wants a password would otherwise wait forever on a prompt
//!     nobody can see, and the button would simply never come back.
//!   - `GIT_OPTIONAL_LOCKS=0`. `status` refreshes the index as a courtesy and
//!     takes `index.lock` to do it. Polled from a sidebar, that courtesy is how
//!     the user's own `git commit` in the pane beside it fails with "another git
//!     process seems to be running".
//!   - `LC_ALL=C`, so the few messages that are parsed are in the language they
//!     were parsed in.
//!
//! Every command is `async` and does its work on the blocking pool: a pull over
//! a slow network is seconds, and a synchronous Tauri command runs on the main
//! thread — the one drawing the window.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// What a status poll is willing to report. A repository with a hundred
/// thousand untracked files has no useful list to draw, and serialising it
/// would stall the sidebar for the privilege of a scrollbar nobody drags.
const MAX_FILES: usize = 5000;
/// A diff drawn in a 220-pixel sidebar is for glancing at. Past this it is cut,
/// and says so.
const MAX_DIFF_BYTES: usize = 512 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitFile {
    /// Relative to the repository root, with forward slashes, as git says it.
    pub path: String,
    /// Where a rename came from.
    pub orig: Option<String>,
    /// The index column of `git status --short`: `M`, `A`, `D`, `R`, `.`…
    pub staged: char,
    /// The worktree column. `?` for untracked, `U`-ish pairs for conflicts.
    pub unstaged: char,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitStatus {
    pub root: String,
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub truncated: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// "3 hours ago", as git words it.
    pub when: String,
}

/* ── Running git ─────────────────────────────────────────────────────────── */

struct Output {
    ok: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    // A console window flashing up for every poll, on a GUI app, on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => "git is not installed, or not on the PATH".to_string(),
        _ => format!("could not run git: {err}"),
    })?;
    Ok(Output {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Run git and hand back stdout, or git's own words for why it did not work.
fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(cwd, args)?;
    if out.ok {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else if out.stderr.is_empty() {
        Err(format!("git {} failed", args.first().unwrap_or(&"")))
    } else {
        Err(out.stderr)
    }
}

/// The repository `cwd` is in, or `None` when it is in none.
fn toplevel(cwd: &Path) -> Option<PathBuf> {
    let out = git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    if !out.ok {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

/// Paths coming back from the frontend are git's own paths going back to git,
/// after a `--`. Refused rather than cleaned when they could not have come from
/// a status list: absolute, or climbing out of the repository.
fn checked_paths(paths: &[String]) -> Result<Vec<&str>, String> {
    if paths.is_empty() {
        return Err("no files given".into());
    }
    paths
        .iter()
        .map(|path| {
            let bad = path.is_empty()
                || path.contains('\0')
                || Path::new(path).is_absolute()
                || path.split(['/', '\\']).any(|part| part == "..");
            if bad {
                Err(format!("refusing an unexpected path: {path}"))
            } else {
                Ok(path.as_str())
            }
        })
        .collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| format!("git task failed: {err}"))?
}

/* ── Parsing ─────────────────────────────────────────────────────────────── */

/// `git status --porcelain=v2 --branch -z`, read.
///
/// Version 2 rather than the short format because it is the one git promises
/// to keep stable, and `-z` because a path with a space, a quote or a newline
/// in it is quoted in every other mode and has to be unquoted to be handed
/// back. With `-z` a path is bytes up to a NUL, and a rename's original path is
/// the *next* NUL-terminated field rather than something after a tab.
pub fn parse_status(raw: &[u8], root: String) -> GitStatus {
    let mut status = GitStatus {
        root,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        truncated: false,
    };
    let text = String::from_utf8_lossy(raw);
    let mut fields = text.split('\0');

    while let Some(record) = fields.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            if let Some(head) = header.strip_prefix("branch.head ") {
                status.branch = (head != "(detached)").then(|| head.to_string());
            } else if let Some(up) = header.strip_prefix("branch.upstream ") {
                status.upstream = Some(up.to_string());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                for part in ab.split(' ') {
                    if let Some(n) = part.strip_prefix('+') {
                        status.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        status.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if status.files.len() >= MAX_FILES {
            status.truncated = true;
            // A rename still owns the field after it; skipping it keeps the
            // stream aligned should anything be read past this point.
            if record.starts_with("2 ") {
                fields.next();
            }
            continue;
        }

        let kind = record.as_bytes()[0];
        match kind {
            // `1 XY sub mH mI mW hH hI path`
            b'1' => {
                if let Some((xy, path)) = split_entry(record, 8) {
                    status.files.push(entry(xy, path, None, false));
                }
            }
            // `2 XY sub mH mI mW hH hI Xscore path` then `origPath` as its own field.
            b'2' => {
                let orig = fields.next().map(str::to_string);
                if let Some((xy, path)) = split_entry(record, 9) {
                    status.files.push(entry(xy, path, orig, false));
                }
            }
            // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
            b'u' => {
                if let Some((xy, path)) = split_entry(record, 10) {
                    status.files.push(entry(xy, path, None, true));
                }
            }
            b'?' => {
                if let Some(path) = record.get(2..) {
                    status.files.push(GitFile {
                        path: path.to_string(),
                        orig: None,
                        staged: '.',
                        unstaged: '?',
                        untracked: true,
                        conflicted: false,
                    });
                }
            }
            // `!` is ignored files, which were not asked for.
            _ => {}
        }
    }
    status
}

/// The `XY` column and the path of a porcelain v2 entry with `before` fields
/// ahead of the path. `splitn` rather than `split`, because the path is the
/// remainder and may itself contain spaces.
fn split_entry(record: &str, before: usize) -> Option<(&str, &str)> {
    let mut parts = record.splitn(before + 1, ' ');
    let _kind = parts.next()?;
    let xy = parts.next()?;
    let path = parts.nth(before - 2)?;
    (xy.len() == 2 && !path.is_empty()).then_some((xy, path))
}

fn entry(xy: &str, path: &str, orig: Option<String>, conflicted: bool) -> GitFile {
    let mut chars = xy.chars();
    GitFile {
        path: path.to_string(),
        orig,
        staged: chars.next().unwrap_or('.'),
        unstaged: chars.next().unwrap_or('.'),
        untracked: false,
        conflicted,
    }
}

/// `git log` with unit and record separators, which no subject line contains.
pub fn parse_log(raw: &str) -> Vec<GitCommit> {
    raw.split('\x1e')
        .filter_map(|record| {
            let mut parts = record.trim_start_matches('\n').split('\x1f');
            let hash = parts.next()?.to_string();
            if hash.is_empty() {
                return None;
            }
            Some(GitCommit {
                hash,
                short: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                when: parts.next()?.trim_end().to_string(),
            })
        })
        .collect()
}

fn cap(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n… diff truncated\n");
    }
    text
}

/* ── Commands ────────────────────────────────────────────────────────────── */

/// The repository `cwd` is in and what has changed in it, or `None` for a
/// directory that is not in one — which is an ordinary answer for a sidebar
/// following a shell around, not an error.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<Option<GitStatus>, String> {
    blocking(move || {
        let Some(root) = toplevel(Path::new(&cwd)) else {
            return Ok(None);
        };
        let out = git_ok_bytes(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )?;
        Ok(Some(parse_status(
            &out,
            root.to_string_lossy().into_owned(),
        )))
    })
    .await
}

fn git_ok_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git(cwd, args)?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(out.stderr)
    }
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let paths = checked_paths(&paths)?;
        let mut args = vec!["add", "--all", "--"];
        args.extend(paths);
        git_ok(Path::new(&root), &args).map(|_| ())
    })
    .await
}

/// Take files back out of the index, keeping what is in the worktree.
///
/// `reset` rather than `restore --staged`: on a repository with no commits yet
/// there is no HEAD to restore from, and `restore` refuses where `reset` simply
/// empties the index entry — which is exactly what unstaging means there.
#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let paths = checked_paths(&paths)?;
        let mut args = vec!["reset", "-q", "--"];
        args.extend(paths);
        git_ok(Path::new(&root), &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<String, String> {
    blocking(move || {
        if message.trim().is_empty() {
            return Err("a commit needs a message".into());
        }
        git_ok(Path::new(&root), &["commit", "-m", &message])
    })
    .await
}

/// One file's diff, as text.
///
/// Untracked files have nothing to diff against, so they are compared with the
/// empty file — which `--no-index` reports by exiting 1, meaning "differs",
/// rather than 0.
#[tauri::command]
pub async fn git_diff(
    root: String,
    path: String,
    staged: bool,
    untracked: bool,
) -> Result<String, String> {
    blocking(move || {
        let path = checked_paths(std::slice::from_ref(&path))?[0].to_string();
        let root = Path::new(&root);
        let text = if untracked {
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            let out = git(
                root,
                &["diff", "--no-color", "--no-index", "--", null, &path],
            )?;
            if !out.ok && out.code != Some(1) {
                return Err(out.stderr);
            }
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else if staged {
            git_ok(root, &["diff", "--no-color", "--cached", "--", &path])?
        } else {
            git_ok(root, &["diff", "--no-color", "--", &path])?
        };
        Ok(cap(text, MAX_DIFF_BYTES))
    })
    .await
}

#[tauri::command]
pub async fn git_log(root: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    blocking(move || {
        let count = format!("-n{}", limit.unwrap_or(30).clamp(1, 200));
        let out = git(
            Path::new(&root),
            &["log", &count, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e"],
        )?;
        // A branch with no commits yet is an empty history, not a failure.
        if !out.ok {
            return Ok(Vec::new());
        }
        Ok(parse_log(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
}

/// `push`, `pull --ff-only`, `fetch` or `init` — the actions that take no files.
///
/// `--ff-only` because a pull that decides to merge opens an editor for the
/// merge message, and there is no terminal here for it to open in.
#[tauri::command]
pub async fn git_action(cwd: String, action: String) -> Result<String, String> {
    blocking(move || {
        let args: &[&str] = match action.as_str() {
            "push" => &["push"],
            "pull" => &["pull", "--ff-only"],
            "fetch" => &["fetch", "--prune"],
            "init" => &["init"],
            _ => return Err(format!("unknown git action: {action}")),
        };
        let out = git(Path::new(&cwd), args)?;
        // Push and pull report progress on stderr even when they succeed.
        let said = [
            String::from_utf8_lossy(&out.stdout).trim(),
            out.stderr.as_str(),
        ]
        .iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
        if out.ok {
            Ok(said)
        } else {
            Err(if said.is_empty() {
                format!("git {action} failed")
            } else {
                said
            })
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_headers_and_every_kind_of_entry() {
        let raw = "# branch.oid 1234\0# branch.head main\0# branch.upstream origin/main\0\
                   # branch.ab +2 -1\0\
                   1 .M N... 100644 100644 100644 aaa bbb src/has space.rs\0\
                   1 A. N... 000000 100644 100644 000 ccc new.txt\0\
                   2 R. N... 100644 100644 100644 ddd eee R100 renamed.rs\0old name.rs\0\
                   u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.rs\0\
                   ? untracked dir/file\0";
        let status = parse_status(raw.as_bytes(), "/repo".into());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let paths: Vec<&str> = status.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "src/has space.rs",
                "new.txt",
                "renamed.rs",
                "conflict.rs",
                "untracked dir/file"
            ]
        );
        assert_eq!(status.files[0].unstaged, 'M');
        assert_eq!(status.files[1].staged, 'A');
        assert_eq!(status.files[2].orig.as_deref(), Some("old name.rs"));
        assert!(status.files[3].conflicted);
        assert!(status.files[4].untracked);
    }

    #[test]
    fn calls_a_detached_head_no_branch() {
        let status = parse_status(b"# branch.head (detached)\0", "/r".into());
        assert_eq!(status.branch, None);
        assert!(status.files.is_empty());
    }

    #[test]
    fn reads_log_records_with_awkward_subjects() {
        let raw = "abc\x1fa\x1ffix: a | b, \"c\"\x1fJo\x1f2 days ago\x1e\n\
                   def\x1fd\x1fsecond\x1fAl\x1f3 weeks ago\x1e\n";
        let log = parse_log(raw);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "fix: a | b, \"c\"");
        assert_eq!(log[1].when, "3 weeks ago");
    }

    #[test]
    fn refuses_paths_that_could_not_have_come_from_status() {
        assert!(checked_paths(&["src/main.rs".into()]).is_ok());
        assert!(checked_paths(&[]).is_err());
        assert!(checked_paths(&["../outside".into()]).is_err());
        assert!(checked_paths(&["/etc/passwd".into()]).is_err());
        assert!(checked_paths(&["a/../../b".into()]).is_err());
    }

    #[test]
    fn works_against_a_real_repository() {
        let dir = std::env::temp_dir().join(format!("jterm-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if git_ok(&dir, &["init", "-q"]).is_err() {
            // No git on this machine; nothing here can be exercised.
            return;
        }
        std::fs::write(dir.join("a file.txt"), "hello\n").unwrap();
        let root = toplevel(&dir).expect("a repository");
        let raw = git_ok_bytes(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )
        .unwrap();
        let status = parse_status(&raw, root.to_string_lossy().into_owned());
        assert_eq!(status.files.len(), 1);
        assert!(status.files[0].untracked);
        assert_eq!(status.files[0].path, "a file.txt");
        std::fs::remove_dir_all(&dir).ok();
    }
}

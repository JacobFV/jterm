//! The sidebar's Search tab: every line under a directory that contains some
//! text, and every file whose name does.
//!
//! Which files count is the question that decides whether this is useful. A
//! search that wades through `node_modules` and `target` is slow and answers
//! with noise, and the rule people already expect is `.gitignore`. So inside a
//! repository the list of files comes from `git ls-files`, which is that rule
//! exactly — tracked files and untracked-but-not-ignored ones. Outside a
//! repository there is no rule to borrow, and a short list of directories that
//! are never what anybody is searching for stands in for one.
//!
//! Only one search runs at a time. Typing issues a new search per pause, and a
//! search of a big tree takes longer than a pause, so every search takes a
//! generation number and gives up as soon as a newer one has started — without
//! that, a fast typist queues up a search per word and the answer to the last
//! one arrives after all the others.
//!
//! Matching is literal, and case-insensitive for ASCII unless asked otherwise.
//! ASCII-only folding keeps byte offsets valid, which is what lets the match be
//! cut out of the line to be highlighted; a non-ASCII letter matches only in
//! the case it was typed.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Files looked at, at most. Past this the result says it is incomplete.
const MAX_FILES: usize = 30_000;
/// Anything bigger is a data file or a build artefact, not source.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_HITS: usize = 1000;
const MAX_HITS_PER_FILE: usize = 50;
const MAX_NAME_MATCHES: usize = 200;
/// A search that has not finished by now is a search of the wrong directory.
const BUDGET: Duration = Duration::from_secs(8);
/// Characters of context kept either side of a match.
const CONTEXT: usize = 80;
/// Directories skipped when there is no `.gitignore` to ask.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    "venv",
];

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// One-based, as editors count.
    pub line: u32,
    /// The line split around the match, so the frontend never has to turn a
    /// byte offset into a UTF-16 one to highlight it.
    pub before: String,
    pub matched: String,
    pub after: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FileHits {
    pub path: String,
    /// Relative to the searched directory, for display.
    pub rel: String,
    pub hits: Vec<Hit>,
}

#[derive(Serialize, Debug, Default)]
pub struct SearchResult {
    pub files: Vec<FileHits>,
    /// Files whose path matches, relative to the searched directory.
    pub names: Vec<String>,
    pub scanned: usize,
    /// Some limit was reached, so this is not every match there is.
    pub truncated: bool,
    /// A newer search started before this one finished. Its result is partial
    /// and should be thrown away.
    pub superseded: bool,
}

/// Every file under `root` worth searching, relative to it.
fn candidates(root: &Path) -> Vec<String> {
    if let Some(files) = git_files(root) {
        return files;
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out
}

fn git_files(root: &Path) -> Option<Vec<String>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|path| !path.is_empty())
            // A file with a merge conflict is listed once per stage.
            .filter(|path| seen.insert(path.to_string()))
            .take(MAX_FILES)
            .map(str::to_string)
            .collect(),
    )
}

/// The fallback walk. Hidden entries are skipped along with `SKIP_DIRS`, and
/// symlinked directories are not followed: a link back up the tree would make
/// the walk go round until the file cap stopped it.
fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_ref()) {
                walk(root, &path, out);
            }
        } else if kind.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Where `needle` first occurs in `line`, as a byte range of `line`.
///
/// `needle` arrives already folded when the search is case-insensitive.
fn find(line: &str, needle: &str, case_sensitive: bool) -> Option<(usize, usize)> {
    let start = if case_sensitive {
        line.find(needle)?
    } else {
        line.to_ascii_lowercase().find(needle)?
    };
    Some((start, start + needle.len()))
}

/// A hit, with the line cut down to some context either side of the match.
fn hit(number: usize, line: &str, (start, end): (usize, usize)) -> Hit {
    let before = &line[..start];
    let skip = before.chars().count().saturating_sub(CONTEXT);
    let before: String = before.chars().skip(skip).collect();
    let after: String = line[end..].chars().take(CONTEXT).collect();
    Hit {
        line: u32::try_from(number).unwrap_or(u32::MAX),
        before: if skip > 0 {
            format!("…{}", before.trim_start())
        } else {
            before.trim_start().to_string()
        },
        matched: line[start..end].to_string(),
        after,
    }
}

/// Search one file's text. Split out so it can be tested without a disk.
pub fn search_text(text: &str, needle: &str, case_sensitive: bool, limit: usize) -> Vec<Hit> {
    let mut hits = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if hits.len() >= limit {
            break;
        }
        if let Some(range) = find(line, needle, case_sensitive) {
            hits.push(hit(index + 1, line, range));
        }
    }
    hits
}

fn run(root: PathBuf, query: String, case_sensitive: bool, generation: u64) -> SearchResult {
    let mut result = SearchResult::default();
    let needle = if case_sensitive {
        query.clone()
    } else {
        query.to_ascii_lowercase()
    };
    let started = Instant::now();
    let files = candidates(&root);
    result.truncated = files.len() >= MAX_FILES;
    let mut total = 0;

    for rel in files {
        if GENERATION.load(Ordering::Relaxed) != generation {
            result.superseded = true;
            return result;
        }
        if started.elapsed() > BUDGET || total >= MAX_HITS {
            result.truncated = true;
            break;
        }
        if result.names.len() < MAX_NAME_MATCHES && find(&rel, &needle, case_sensitive).is_some() {
            result.names.push(rel.clone());
        }

        let path = root.join(&rel);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        result.scanned += 1;
        // A NUL early on is the cheap, reliable sign of a binary file.
        if bytes.iter().take(8000).any(|byte| *byte == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let hits = search_text(&text, &needle, case_sensitive, MAX_HITS_PER_FILE);
        if hits.is_empty() {
            continue;
        }
        total += hits.len();
        result.files.push(FileHits {
            path: path.to_string_lossy().into_owned(),
            rel,
            hits,
        });
    }
    result
}

#[tauri::command]
pub async fn search_files(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<SearchResult, String> {
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    if query.is_empty() {
        return Ok(SearchResult::default());
    }
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let case_sensitive = case_sensitive.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || run(root, query, case_sensitive, generation))
        .await
        .map_err(|err| format!("search failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_every_line_and_numbers_from_one() {
        let hits = search_text("alpha\nBeta gamma\nbeta\n", "beta", false, 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].matched, "Beta");
        assert_eq!(hits[0].after, " gamma");
        assert_eq!(hits[1].line, 3);
    }

    #[test]
    fn respects_case_when_asked() {
        assert_eq!(search_text("Beta\nbeta", "beta", true, 10).len(), 1);
    }

    #[test]
    fn cuts_long_lines_around_the_match_without_splitting_characters() {
        let line = format!("{}needle{}", "é".repeat(300), "ü".repeat(300));
        let hits = search_text(&line, "needle", false, 10);
        assert!(hits[0].before.starts_with('…'));
        assert_eq!(hits[0].before.chars().count(), CONTEXT + 1);
        assert_eq!(hits[0].after.chars().count(), CONTEXT);
    }

    #[test]
    fn stops_at_the_per_file_limit() {
        let text = "x\n".repeat(500);
        assert_eq!(search_text(&text, "x", false, 7).len(), 7);
    }

    #[test]
    fn walks_a_plain_directory_skipping_what_nobody_searches() {
        let dir = std::env::temp_dir().join(format!("jterm-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "fn needle() {}\n").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "needle").unwrap();
        std::fs::write(dir.join(".hidden/x"), "needle").unwrap();
        std::fs::write(dir.join("bin.dat"), b"needle\0\0").unwrap();

        let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let mut found = Vec::new();
        walk(&dir, &dir, &mut found);
        found.sort();
        assert_eq!(found, ["bin.dat", "src/lib.rs"]);

        // The directory is not a repository, unless the temp dir is inside one;
        // either way the only text hit is the source file.
        let result = run(dir.clone(), "NEEDLE".into(), false, generation);
        if !result.superseded {
            let rels: Vec<&str> = result.files.iter().map(|file| file.rel.as_str()).collect();
            assert_eq!(rels, ["src/lib.rs"]);
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}

//! How the sidebar's agent is started, with jterm's MCP server plugged into it.
//!
//! Three CLIs, three ways of being told about a server, and one requirement
//! across all of them: the server is *always* there. Not left to the user's
//! own MCP configuration, and not added to it either — nothing here writes
//! into `~/.claude.json`, `~/.codex/config.toml` or `~/.gemini`, because the
//! endpoint and the token change on every launch and a stale entry left in a
//! file the user owns would be a broken server in every agent they run
//! anywhere else. Each agent is told for its own run only:
//!
//!   - **Claude Code** takes `--mcp-config <file>`, which adds to whatever else
//!     it has configured.
//!   - **Codex** takes `-c` overrides of `config.toml` for this run, and reads
//!     the bearer token from an environment variable it is told the name of.
//!   - **Gemini CLI** has no flag for it. It does read its system settings file
//!     from wherever `GEMINI_CLI_SYSTEM_SETTINGS_PATH` says, and system settings
//!     are the layer nothing else overrides — so the server is written into a
//!     copy of that file, carrying across whatever the real one already held.
//!
//! The token never goes on a command line, where every local user can read it
//! out of the process table. It travels in the environment (readable only by
//! the same user) or in a file under jterm's data directory created `0600`.
//!
//! Each agent is also started with its approvals off — `--dangerously-skip-
//! permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo` — unless
//! the user's own arguments already say how approvals should work. See
//! `bypass_flag`.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// The name the server has in every agent's list of servers. Tools show up as
/// `mcp__jterm__list_panes` and the like. No underscore, which Gemini's policy
/// engine would misread as a separator.
pub const SERVER_NAME: &str = "jterm";
pub const TOKEN_ENV: &str = "JTERM_MCP_TOKEN";
pub const URL_ENV: &str = "JTERM_MCP_URL";

/// The agents the sidebar knows how to connect. Ids match `lib/programs.ts`.
pub const TOOLS: [&str; 3] = ["claude", "codex", "gemini"];

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Work out what to run, writing whatever configuration file the agent reads.
///
/// `command` replaces the agent's own name when the user gave one — a path, or
/// `npx @google/gemini-cli` — and `args` are the user's extra arguments.
pub fn plan(
    tool: &str,
    command: &[String],
    args: &[String],
    endpoint: &str,
    token: &str,
    config_dir: &Path,
    window: &str,
) -> Result<Plan, String> {
    if !TOOLS.contains(&tool) {
        return Err(format!("unknown agent: {tool}"));
    }
    let mut argv: Vec<String> = if command.is_empty() {
        vec![tool.to_string()]
    } else {
        command.to_vec()
    };
    let mut env = vec![
        (URL_ENV.to_string(), endpoint.to_string()),
        (TOKEN_ENV.to_string(), token.to_string()),
    ];

    let bypass = bypass_flag(tool, command.iter().chain(args));

    match tool {
        "claude" => {
            let file = config_dir.join(format!("claude-{window}.json"));
            write_private(&file, &claude_config(endpoint, token))?;
            argv.extend(bypass.map(String::from));
            // After the user's arguments, not before: `--mcp-config` takes a
            // list, and put first it would swallow a prompt given after it.
            argv.extend(args.iter().cloned());
            argv.push("--mcp-config".into());
            argv.push(file.to_string_lossy().into_owned());
        }
        "codex" => {
            argv.extend(codex_overrides(endpoint));
            argv.extend(bypass.map(String::from));
            argv.extend(args.iter().cloned());
        }
        _ => {
            let file = config_dir.join(format!("gemini-{window}.json"));
            let existing = gemini_system_settings()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            write_private(&file, &gemini_settings(existing, endpoint, token))?;
            argv.extend(bypass.map(String::from));
            argv.extend(args.iter().cloned());
            env.push((
                "GEMINI_CLI_SYSTEM_SETTINGS_PATH".into(),
                file.to_string_lossy().into_owned(),
            ));
        }
    }
    Ok(Plan { argv, env })
}

/// The flag that stops the agent asking before it acts, unless the user has
/// already said something about that themselves.
///
/// The sidebar's agent runs with its approvals off: it is an agent the user
/// started on purpose, in a window they are watching, and one that stops to ask
/// before every `ls` — or before every jterm tool — is not what it is for.
///
/// Left out when the command line already carries the flag, or one that says
/// how approvals should work instead. The CLIs refuse the combination rather
/// than picking one — Codex's bypass conflicts with `--full-auto`, `--sandbox`
/// and `--ask-for-approval`, and Gemini will not take `--yolo` beside
/// `--approval-mode` — and a choice the user typed into Settings outranks this
/// default.
pub fn bypass_flag<'a>(
    tool: &str,
    words: impl IntoIterator<Item = &'a String>,
) -> Option<&'static str> {
    let (flag, conflicts): (&'static str, &[&str]) = match tool {
        "claude" => ("--dangerously-skip-permissions", &["--permission-mode"]),
        "codex" => (
            "--dangerously-bypass-approvals-and-sandbox",
            &[
                "--full-auto",
                "--sandbox",
                "-s",
                "--ask-for-approval",
                "-a",
                "--yolo",
            ],
        ),
        "gemini" => ("--yolo", &["-y", "--approval-mode"]),
        _ => return None,
    };
    let said = words.into_iter().any(|word| {
        let name = word.split('=').next().unwrap_or(word);
        name == flag || conflicts.contains(&name)
    });
    (!said).then_some(flag)
}

pub fn claude_config(endpoint: &str, token: &str) -> Value {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "http",
                "url": endpoint,
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    })
}

/// `-c key=value` pairs. The value is parsed as TOML, and a JSON string is a
/// valid TOML basic string.
pub fn codex_overrides(endpoint: &str) -> Vec<String> {
    let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
    vec![
        "-c".into(),
        format!("mcp_servers.{SERVER_NAME}.url={}", quoted(endpoint)),
        "-c".into(),
        format!(
            "mcp_servers.{SERVER_NAME}.bearer_token_env_var={}",
            quoted(TOKEN_ENV)
        ),
    ]
}

/// The system settings Gemini would have read, with jterm's server added.
///
/// A file that is not a JSON object — including one with comments in it, which
/// Gemini tolerates and this does not try to — is replaced rather than merged,
/// since there is nothing reliable to merge into.
pub fn gemini_settings(existing: Option<Value>, endpoint: &str, token: &str) -> Value {
    let mut root = match existing {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    if !servers.is_object() {
        *servers = Value::Object(Map::new());
    }
    if let Value::Object(servers) = servers {
        servers.insert(
            SERVER_NAME.into(),
            json!({
                "httpUrl": endpoint,
                "headers": { "Authorization": format!("Bearer {token}") },
                "description": "The jterm window this agent is running in",
            }),
        );
    }
    Value::Object(root)
}

/// Where Gemini looks for system settings when nobody has moved them.
fn gemini_system_settings() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GEMINI_CLI_SYSTEM_SETTINGS_PATH") {
        return Some(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    let path = "/Library/Application Support/GeminiCli/settings.json";
    #[cfg(windows)]
    let path = r"C:\ProgramData\gemini-cli\settings.json";
    #[cfg(not(any(target_os = "macos", windows)))]
    let path = "/etc/gemini-cli/settings.json";
    Some(PathBuf::from(path))
}

/// Put the agent behind the user's shell, so it is found where they would find it.
///
/// `claude` is very often somewhere only the shell's rc files put on the PATH —
/// `~/.local/bin`, an nvm directory — and a GUI app does not read those. So a
/// shell that understands `"$0" "$@"` runs it: the argv is handed over as
/// positional parameters, never spliced into a string, so nothing in it needs
/// quoting. The shell `exec`s the agent and is gone.
///
/// Interactive on Linux so `.bashrc` is read; login *and* interactive on macOS,
/// where a GUI app's environment is bare and the PATH is in the login files.
/// Any other shell — fish, nushell — and Windows run the program directly.
pub fn through_shell(shell: &str, argv: Vec<String>) -> (String, Vec<String>) {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let posix = matches!(name, "bash" | "zsh" | "sh" | "dash" | "ksh" | "mksh");
    if cfg!(windows) || !posix || argv.is_empty() {
        let mut argv = argv.into_iter();
        let head = argv.next().unwrap_or_default();
        return (head, argv.collect());
    }
    let mut tail: Vec<String> = if cfg!(target_os = "macos") {
        vec!["-l".into(), "-i".into()]
    } else {
        vec!["-i".into()]
    };
    tail.push("-c".into());
    tail.push(r#"exec "$0" "$@""#.into());
    tail.extend(argv);
    (shell.to_string(), tail)
}

/// Write a file only this user can read. The directory is made private too, so
/// there is no moment where the file exists with looser permissions.
fn write_private(path: &Path, value: &Value) -> Result<(), String> {
    let fail = |err: std::io::Error| format!("could not write {}: {err}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path).map_err(fail)?;
    // `mode` only applies to a file being created; one left from an earlier
    // version of this, or made by hand, is tightened as well.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(text.as_bytes()).map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:4242/mcp/main";

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("jterm-agent-cli-{}", std::process::id()))
    }

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn claude_gets_a_config_file_after_the_users_arguments() {
        let dir = scratch();
        let plan = plan(
            "claude",
            &[],
            &words(&["--model", "opus"]),
            URL,
            "t0k",
            &dir,
            "main",
        )
        .unwrap();
        let file = dir.join("claude-main.json");
        assert_eq!(
            plan.argv,
            words(&[
                "claude",
                "--dangerously-skip-permissions",
                "--model",
                "opus",
                "--mcp-config",
                &file.to_string_lossy()
            ])
        );
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(written, claude_config(URL, "t0k"));
        assert_eq!(
            written["mcpServers"]["jterm"]["headers"]["Authorization"],
            "Bearer t0k"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "nobody else may read the token");
        }
        assert!(plan.env.contains(&(TOKEN_ENV.into(), "t0k".into())));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_is_told_by_overrides_and_never_sees_the_token_in_argv() {
        let plan = plan(
            "codex",
            &words(&["/opt/codex"]),
            &words(&["--full-auto"]),
            URL,
            "secret",
            &scratch(),
            "w-1",
        )
        .unwrap();
        assert_eq!(plan.argv[0], "/opt/codex");
        assert_eq!(
            plan.argv[1..5],
            words(&[
                "-c",
                &format!("mcp_servers.jterm.url=\"{URL}\""),
                "-c",
                "mcp_servers.jterm.bearer_token_env_var=\"JTERM_MCP_TOKEN\"",
            ])
        );
        assert_eq!(plan.argv.last().unwrap(), "--full-auto");
        // The user's own approval mode stands; Codex refuses both at once.
        assert!(!plan
            .argv
            .contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(plan.argv.iter().all(|word| !word.contains("secret")));
    }

    #[test]
    fn gemini_keeps_what_the_system_file_already_said() {
        let existing = json!({
            "general": { "vimMode": true },
            "mcpServers": { "other": { "command": "x" } }
        });
        let merged = gemini_settings(Some(existing), URL, "t");
        assert_eq!(merged["general"]["vimMode"], true);
        assert_eq!(merged["mcpServers"]["other"]["command"], "x");
        assert_eq!(merged["mcpServers"]["jterm"]["httpUrl"], URL);

        let replaced = gemini_settings(Some(json!([1, 2])), URL, "t");
        assert_eq!(replaced["mcpServers"]["jterm"]["httpUrl"], URL);
        let broken = gemini_settings(Some(json!({ "mcpServers": 5 })), URL, "t");
        assert_eq!(broken["mcpServers"]["jterm"]["httpUrl"], URL);
    }

    #[test]
    fn turns_approvals_off_unless_the_user_already_chose() {
        let none: Vec<String> = Vec::new();
        assert_eq!(
            bypass_flag("claude", &none),
            Some("--dangerously-skip-permissions")
        );
        assert_eq!(
            bypass_flag("codex", &none),
            Some("--dangerously-bypass-approvals-and-sandbox")
        );
        assert_eq!(bypass_flag("gemini", &none), Some("--yolo"));

        // Already there: not added a second time.
        assert_eq!(
            bypass_flag("claude", &words(&["--dangerously-skip-permissions"])),
            None
        );
        // A different choice about approvals, in either spelling.
        assert_eq!(
            bypass_flag("claude", &words(&["--permission-mode", "plan"])),
            None
        );
        assert_eq!(bypass_flag("codex", &words(&["-a", "on-request"])), None);
        assert_eq!(bypass_flag("codex", &words(&["--sandbox=read-only"])), None);
        assert_eq!(
            bypass_flag("gemini", &words(&["--approval-mode=auto_edit"])),
            None
        );
        // Unrelated arguments change nothing.
        assert_eq!(
            bypass_flag("gemini", &words(&["--model", "gemini-2.5-pro"])),
            Some("--yolo")
        );

        let gemini = plan("gemini", &[], &[], URL, "t", &scratch(), "main").unwrap();
        assert_eq!(gemini.argv, words(&["gemini", "--yolo"]));
        std::fs::remove_dir_all(scratch()).ok();
    }

    #[test]
    fn refuses_an_agent_it_does_not_know() {
        assert!(plan("rm", &[], &[], URL, "t", &scratch(), "main").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn hands_the_argv_to_a_posix_shell_as_parameters() {
        let (head, tail) = through_shell("/bin/bash", words(&["claude", "it's \"quoted\""]));
        assert_eq!(head, "/bin/bash");
        let n = tail.len();
        assert_eq!(
            tail[n - 4..],
            words(&["-c", r#"exec "$0" "$@""#, "claude", "it's \"quoted\""])
        );

        let (head, tail) = through_shell("/usr/bin/fish", words(&["claude", "--x"]));
        assert_eq!((head.as_str(), tail), ("claude", words(&["--x"])));
    }

    #[cfg(not(windows))]
    #[test]
    fn the_shell_trick_really_runs_the_program() {
        let (head, tail) = through_shell("/bin/sh", words(&["printf", "%s|", "a b", "$HOME"]));
        // `-i` would make a non-tty `sh` chatty; the argv handling is what is
        // under test, so it is dropped for this run.
        let tail: Vec<String> = tail
            .into_iter()
            .filter(|word| word != "-i" && word != "-l")
            .collect();
        let out = std::process::Command::new(head)
            .args(tail)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a b|$HOME|");
    }
}

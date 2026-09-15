/**
 * What a pane is *for*, worked out from what it is running.
 *
 * One table answers two questions that turn out to be the same question:
 *
 *   - **Which icon.** A row of tabs all wearing the same terminal glyph tells
 *     you nothing; the tab running Claude, the one on the production host and
 *     the one watching a build are different things and should look different.
 *   - **How to get it back.** When a pane's shell did not survive — the machine
 *     went down, not just the window — the honest thing jterm can offer is the
 *     command that was running, typed back at the prompt. Some tools can pick
 *     up where they left off if asked properly (`claude --continue`), and that
 *     is a property of the same program this table already had to know about.
 *
 * Detection is by the head of the command line, and deliberately shallow: the
 * first word, after stripping the things people put in front of a command
 * (`sudo`, `env FOO=1`, `uv run`, `npx`). A pane running `claude` inside `nvim`
 * inside `ssh` is not something a regular expression should have opinions
 * about, and guessing wrong is worse than the plain terminal icon.
 *
 * Nothing here is ever *applied* to a pane. It is a guess, offered live from
 * whatever the pane last ran, and any pane can be given an icon by hand that
 * overrides it — see `PaneCommon.profile`. Names and commands are the user's
 * data, so the guess stays a guess.
 */

import {
  Activity,
  Boxes,
  Bot,
  Cloud,
  Container,
  Database,
  FileCode,
  Hammer,
  KeyRound,
  Server,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";

import {
  SiClaude,
  SiDocker,
  SiGemini,
  SiGit,
  SiKubernetes,
  SiNode,
  SiOllama,
  SiOpenAI,
  SiPostgres,
  SiPython,
  SiTerraform,
  type BrandMark,
} from "./brandIcons";

/** Either kind of glyph. They are drawn the same way at the same size. */
export type ProgramIcon = LucideIcon | BrandMark;

export interface Program {
  id: string;
  /** What the icon picker calls it. */
  label: string;
  /** Which family it belongs to, so the picker is a menu and not a wall. */
  group: "AI" | "Development" | "Operations" | "Data" | "Shell";
  icon: ProgramIcon;
  /** Command names that mean a pane is this. First word only — see above. */
  commands?: string[];
  /**
   * How to pick this program's own session back up, when it has a way.
   *
   * Typed at the prompt and never run, which is the promise the restored draft
   * line already makes: jterm puts the words there, you decide.
   */
  resume?: string;
}

/**
 * The catalogue.
 *
 * Ordered within each group by how often the thing is what a pane is for, since
 * that is also the order the picker shows.
 */
export const PROGRAMS: Program[] = [
  {
    id: "claude",
    label: "Claude Code",
    group: "AI",
    icon: SiClaude,
    commands: ["claude"],
    // `--continue` picks up the most recent conversation in this directory,
    // which is what "where I was" means for a session that was interrupted.
    resume: "claude --continue",
  },
  {
    id: "codex",
    label: "Codex",
    group: "AI",
    icon: SiOpenAI,
    commands: ["codex"],
    resume: "codex resume --last",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    group: "AI",
    icon: SiGemini,
    commands: ["gemini"],
    resume: "gemini --resume latest",
  },
  {
    id: "aider",
    label: "Aider",
    group: "AI",
    icon: Bot,
    commands: ["aider"],
    // Aider reads its own chat history back on start, so simply running it
    // again is the resume.
    resume: "aider",
  },
  {
    id: "ollama",
    label: "Local model",
    group: "AI",
    icon: SiOllama,
    commands: ["ollama", "llama", "llm"],
  },

  {
    id: "dev",
    label: "General dev",
    group: "Development",
    icon: TerminalSquare,
  },
  {
    id: "editor",
    label: "Editor",
    group: "Development",
    icon: FileCode,
    commands: ["vim", "nvim", "vi", "emacs", "hx", "helix", "nano", "micro"],
  },
  {
    id: "vcs",
    label: "Version control",
    group: "Development",
    icon: SiGit,
    commands: ["git", "lazygit", "gh", "glab", "jj", "tig"],
  },
  {
    id: "build",
    label: "Build & test",
    group: "Development",
    icon: Hammer,
    commands: ["make", "cargo", "npm", "pnpm", "yarn", "bun", "gradle", "mvn", "just", "bazel"],
  },
  {
    id: "node",
    label: "Node",
    group: "Development",
    icon: SiNode,
    commands: ["node", "deno", "tsx", "ts-node"],
  },
  {
    id: "python",
    label: "Python",
    group: "Development",
    icon: SiPython,
    commands: ["python", "python3", "ipython", "pytest", "poetry", "uv", "pip"],
  },

  {
    id: "ssh",
    label: "Remote host",
    group: "Operations",
    icon: Server,
    commands: ["ssh", "mosh", "et"],
    // The command carries the host, so re-typing it is exactly the resume.
    resume: "",
  },
  {
    id: "docker",
    label: "Containers",
    group: "Operations",
    icon: SiDocker,
    commands: ["docker", "podman", "docker-compose", "lazydocker", "nerdctl"],
  },
  {
    id: "k8s",
    label: "Kubernetes",
    group: "Operations",
    icon: SiKubernetes,
    commands: ["kubectl", "k9s", "helm", "kubectx", "kubens", "minikube", "kind"],
  },
  {
    id: "terraform",
    label: "Infrastructure",
    group: "Operations",
    icon: SiTerraform,
    commands: ["terraform", "tofu", "pulumi", "ansible", "ansible-playbook", "vagrant"],
  },
  {
    id: "cloud",
    label: "Cloud",
    group: "Operations",
    icon: Cloud,
    commands: ["aws", "gcloud", "az", "flyctl", "fly", "wrangler", "doctl", "heroku"],
  },
  {
    id: "monitor",
    label: "Watching",
    group: "Operations",
    icon: Activity,
    commands: ["top", "htop", "btop", "watch", "journalctl", "tail", "systemctl", "bpytop"],
  },
  {
    id: "secrets",
    label: "Secrets",
    group: "Operations",
    icon: KeyRound,
    commands: ["vault", "sops", "gpg", "pass", "op", "age"],
  },

  {
    id: "sql",
    label: "Database",
    group: "Data",
    icon: SiPostgres,
    commands: ["psql", "mysql", "sqlite3", "usql", "pgcli", "mycli", "duckdb"],
  },
  {
    id: "store",
    label: "Key-value store",
    group: "Data",
    icon: Database,
    commands: ["redis-cli", "mongosh", "mongo", "etcdctl", "consul"],
  },
  {
    id: "queue",
    label: "Streams & queues",
    group: "Data",
    icon: Boxes,
    commands: ["kafkacat", "kcat", "rabbitmqctl", "nats"],
  },

  {
    id: "shell",
    label: "Shell",
    group: "Shell",
    icon: TerminalSquare,
    commands: ["bash", "zsh", "fish", "sh", "nu", "pwsh"],
  },
  {
    id: "session",
    label: "Session",
    group: "Shell",
    icon: Container,
    commands: ["tmux", "screen", "zellij", "abduco", "dtach"],
  },
];

const BY_ID = new Map(PROGRAMS.map((program) => [program.id, program]));

const BY_COMMAND = new Map<string, Program>();
for (const program of PROGRAMS) {
  for (const command of program.commands ?? []) {
    // First definition wins, so the order of the table above is also the order
    // in which two entries claiming one command are resolved.
    if (!BY_COMMAND.has(command)) BY_COMMAND.set(command, program);
  }
}

export function programById(id: string | undefined): Program | null {
  return id === undefined ? null : (BY_ID.get(id) ?? null);
}

/** Things people put in front of a command that are not the command. */
const PREFIXES = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "nice",
  "nohup",
  "command",
  "exec",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
]);

/**
 * The program a command line is running, as far as the first word can say.
 *
 * `env FOO=1 sudo npx claude` is Claude Code; `./claude-helper.sh` is not
 * pretending to be. Assignments and the wrappers above are stepped over, the
 * path is dropped, and the result is looked up — no deeper than that, because
 * anything deeper is guessing about somebody's shell.
 */
export function programForCommand(command: string | undefined): Program | null {
  if (!command) return null;

  for (const word of command.trim().split(/\s+/)) {
    // `FOO=bar cmd` — an assignment is not the command.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    // The name, without the path it was reached by.
    const name = word.split(/[\\/]/).pop() ?? "";
    if (!name || name.startsWith("-")) continue;
    if (PREFIXES.has(name)) continue;
    return BY_COMMAND.get(name) ?? null;
  }
  return null;
}

/**
 * What to type back at the prompt of a pane whose shell did not survive.
 *
 * The general answer is "the command it was running": jterm cannot know what a
 * program had in memory, but it does know what was started, and having the
 * line back is the difference between resuming and remembering. Where a tool
 * has its own resume, that is used instead — see `Program.resume`.
 *
 * `null` for a command not worth handing back: a finished `ls` is not a session
 * anybody wants restored, and only the programs this table knows about are
 * offered, so a pane does not come back with something surprising pre-typed.
 */
export function resumeLine(command: string | undefined): string | null {
  const program = programForCommand(command);
  if (program === null || program.resume === undefined) return null;
  // An empty `resume` means "the command itself" — `ssh prod` resumes by being
  // run again, and the host is in the line rather than in this table.
  return program.resume === "" ? (command?.trim() ?? null) : program.resume;
}

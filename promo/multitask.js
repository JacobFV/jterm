// Five looping seconds for the download page: a single jterm tab split into 25
// panes, each with Claude Code at work somewhere else on the disk.
//
// All of it is drawn. Nothing here starts jterm, a shell or an agent, and every
// project, path and number is invented. It is painted by the film's own `ui.js`,
// so the window chrome cannot drift away from the film's, and it adds only the
// one pane body the film did not need: an agent session that fits whatever width
// its split happens to give it. Loaded on top of index.html by multitask.py.
//
// The loop has no seam because no pane is ever asked to end where it began in
// any way the eye can catch. Each runs its own cycle of the same length from its
// own starting offset, and is a pure function of the frame number, so frame 150
// is frame 0 exactly. A pane's jump back to the start of its cycle lands at a
// different moment from everyone else's and reads as one more screen redraw.

const CC_FONT_PX = 12, CC_ROW_PX = 16, LOOP_FRAMES = 150;

// Claude Code colours inline code rather than printing the backticks.
const say = (s) => "«w:●» " + s.replace(/`([^`]+)`/g, "«b:$1»");
const you = (s) => ({ cls: "ccyou", t: "«d:>» " + s });
const tool = (name, arg) => `«g:●» «w:${name}»(${arg})`;
const busy = (name, arg) => `«cco:●» «w:${name}»(${arg})`;
const bad = (name, arg) => `«r:●» «w:${name}»(${arg})`;
const out = (s) => "  «d:⎿»  " + s;
const more = (s) => "     " + s;
const add = (n, s) => ({ cls: "ccadd", clip: 1, t: `     «d:${n}» «g:+» ${s}` });
const del = (n, s) => ({ cls: "ccdel", clip: 1, t: `     «d:${n}» «r:-» ${s}` });
const ctx = (n, s) => ({ clip: 1, t: `     «d:${n}   ${s}»` });
const todo = (rows) => [tool("Update Todos", "").replace("()", "")].concat(rows.map(([st, s], i) => {
  const lead = i ? "     " : "  «d:⎿»  ";
  if (st === "x") return `${lead}«g:☒» «d:${s}»`;
  return st === ">" ? `${lead}«cco:☐» «w:${s}»` : `${lead}«d:☐ ${s}»`;
}));
const spin = (verb, took, extra = "") => ({ spin: { verb, took, extra } });

// What a session has usually been doing before the part worth showing. Panes
// differ in height, and an agent's terminal is never half empty, so each one is
// topped up from its own project's files until the screen is full.
function earlier(s, need) {
  const lines = [];
  for (let i = 0; lines.length < need; i++) {
    const f = s.files[i % s.files.length], r = hash(i + s.dir.length * 7);
    if (i % 3 === 1) lines.push(tool("Search", `pattern: "${s.grep}", path: "${f.split("/")[0]}"`), out(`Found ${2 + Math.floor(r * 19)} files`));
    else lines.push(tool("Read", f), out(`Read ${40 + Math.floor(r * 860)} lines`));
    lines.push("");
  }
  return lines;
}

const SESSIONS = {
  a: {
    dir: "~/work/checkout-api", branch: "fix/idempotent-retry", left: 62, mode: "edits", grep: "idempotencyKey",
    files: ["src/payments/charge.ts", "src/payments/retry.ts", "test/charge.test.ts"],
    log: [
      you("a retried charge can bill twice, find out why"),
      "",
      say("The retry path mints a fresh idempotency key on every attempt, so the provider sees each one as new."),
      "",
      tool("Update", "src/payments/retry.ts"),
      out("Updated with «g:2» additions and «r:1» removal"),
      del(41, "const key = crypto.randomUUID();"),
      add(41, "const key = order.idempotencyKey"),
      add(42, "  ?? deriveKey(order.id, order.total);"),
      "",
      busy("Bash", "npm test -- charge"),
      out("«d:Running… {38..97} of 112»"),
      "",
      spin("Reconciling", "1m 52s", "↓ 6.1k tokens"),
    ],
  },
  b: {
    dir: "/etc/nginx/sites-available", branch: "", left: 88, mode: "ask", grep: "proxy_pass",
    files: ["storefront.conf", "api.conf", "../nginx.conf"],
    ask: { title: "Bash command", cmd: "sudo nginx -t && sudo systemctl reload nginx", why: "Validate the config, then reload" },
    log: [
      you("websocket upgrades are 502ing on /live"),
      "",
      say("`/live` never forwards the Upgrade header, and the read timeout is 30s."),
      "",
      tool("Update", "api.conf"),
      out("Updated with «g:3» additions"),
      add(58, 'proxy_set_header Upgrade $http_upgrade;'),
      add(59, 'proxy_set_header Connection "upgrade";'),
      add(60, "proxy_read_timeout 3600s;"),
    ],
  },
  c: {
    dir: "~/ml/diffusion-eval", branch: "main", left: 31, mode: "auto", grep: "guidance_scale",
    files: ["eval/fid.py", "configs/sdxl.yaml", "notebooks/sweep.py"],
    log: [
      you("sweep guidance 3 to 9, plot FID against it"),
      "",
      tool("Bash", "python eval/sweep.py --cfg 3:9:1"),
      out("cfg=3.0  «d:fid»  24.81"),
      more("cfg=4.0  «d:fid»  19.37"),
      more("cfg=5.0  «d:fid»  «G:17.02»"),
      more("cfg=6.0  «d:fid»  17.64"),
      more("«d:… +3 lines (ctrl+o to expand)»"),
      "",
      say("The minimum is at 5.0. Past 7 it climbs quickly."),
      "",
      busy("Write", "reports/guidance.png"),
      "",
      spin("Plotting", "48s", "↑ 1.2k tokens"),
    ],
  },
  d: {
    dir: "~/infra/terraform/prod-eu", branch: "chore/rds-16", left: 54, mode: "plan", grep: "engine_version",
    files: ["rds.tf", "variables.tf", "modules/db/main.tf"],
    log: [
      you("plan the postgres 16 upgrade, change nothing yet"),
      "",
      tool("Bash", "terraform plan -no-color"),
      out("«y:~» aws_db_instance.primary"),
      more("«y:~» aws_db_parameter_group.pg"),
      more("«g:+» aws_db_snapshot.pre_upgrade"),
      more("Plan: «g:1» to add, «y:2» to change, «r:0» to destroy."),
      "",
      say("Snapshot first, upgrade the replica, promote, then the old primary. About 4 minutes of read-only."),
      "",
      "«cco:✳» «w:Ready to code?» «d:Waiting for your approval»",
    ],
  },
  e: {
    dir: "~/games/roguelike", branch: "feat/fov", left: 73, mode: "edits", draft: "nice, now doors", grep: "shadowcast",
    files: ["src/fov.rs", "src/map.rs", "src/render.rs"],
    log: [
      you("walls flicker at the edge of the field of view"),
      "",
      ...todo([["x", "Reproduce on the cave seed"], ["x", "Fix octant slope rounding"], [">", "Add a symmetry test"], ["", "Profile at 200×200"]]),
      "",
      busy("Write", "tests/fov_symmetry.rs"),
      "",
      spin("Shadowcasting", "3m 07s", "↓ 11.4k tokens"),
    ],
  },
  f: {
    dir: "~/mobile/ios-app", branch: "release/4.2", left: 12, mode: "edits", grep: "PaywallView",
    files: ["App/Paywall/PaywallView.swift", "App/Store.swift", "Tests/StoreTests.swift"],
    log: [
      you("xcodebuild fails on the release scheme"),
      "",
      bad("Bash", "xcodebuild -scheme App -configuration Release"),
      out("«r:error:» cannot find 'PaywallView' in scope"),
      more("«R:** BUILD FAILED **»"),
      "",
      say("The file is only in the Debug target. Adding it to Release."),
      "",
      tool("Update", "App.xcodeproj/project.pbxproj"),
      out("Updated with «g:2» additions"),
      "",
      spin("Compiling", "6m 40s", "↓ 21k tokens"),
    ],
  },
  g: {
    dir: "~/data/warehouse/dbt", branch: "orders-v2", left: 47, mode: "auto", grep: "ref('stg_orders')",
    files: ["models/marts/orders.sql", "models/staging/stg_orders.sql", "models/schema.yml"],
    log: [
      you("rebuild orders incrementally"),
      "",
      tool("Bash", "dbt build -s +orders"),
      out("«G:PASS» stg_orders «d:[3.1s]»"),
      more("«G:PASS» stg_refunds «d:[1.4s]»"),
      more("«R:FAIL» unique_orders_order_id «d:[0.8s]»"),
      "",
      say("212 duplicates, all from the late-arriving window. I'll dedupe on `updated_at`."),
      "",
      busy("Update", "models/marts/orders.sql"),
      "",
      spin("Deduplicating", "2m 03s"),
    ],
  },
  h: {
    dir: "~/firmware/drone-fc", branch: "pid-autotune", left: 39, mode: "ask", grep: "gyro_lpf",
    files: ["src/control/pid.c", "src/drivers/imu.c", "include/config.h"],
    ask: { title: "Bash command", cmd: "make flash TARGET=f7", why: "Flash the board on /dev/ttyACM0" },
    log: [
      you("oscillation on yaw after the filter change"),
      "",
      say("The new low-pass adds 2.3 ms of delay, so yaw D is now too high."),
      "",
      tool("Update", "src/control/pid.c"),
      out("Updated with «g:1» addition and «r:1» removal"),
      del(212, "#define YAW_D 0.0042f"),
      add(212, "#define YAW_D 0.0028f"),
    ],
  },
  // The one big pane, in the middle: when the picture is scaled down to fit a
  // page this is what the eye can actually read.
  i: {
    dir: "~/compilers/lox-vm", branch: "gc/generational", left: 58, mode: "edits",
    draft: "then race binary_trees against main", grep: "markRoots",
    files: ["src/gc.c", "src/vm.c", "src/object.h", "test/gc/stress.lox"],
    log: [
      you("add a nursery to the collector, keep the stress tests green"),
      "",
      say("Objects start in a bump-allocated nursery and survivors get promoted. The write barrier is the risky part, so that goes first."),
      "",
      ...todo([["x", "Write barrier on field and upvalue stores"], ["x", "Bump allocator for the nursery"], [">", "Minor collection and promotion"], ["", "Run the stress suite with GC on every alloc"], ["", "Compare the binary_trees benchmark"]]),
      "",
      tool("Update", "src/gc.c"),
      out("Updated with «g:7» additions and «r:1» removal"),
      ctx(187, "static void minorCollect(void) {"),
      ctx(188, "  markRoots();"),
      del(189, "  traceReferences();"),
      add(189, "  markRememberedSet(&vm.remembered);"),
      add(190, "  traceNursery();"),
      add(191, ""),
      add(192, "  for (Obj* o = vm.nursery.first; o; o = o->next) {"),
      add(193, "    if (o->isMarked) promote(o);"),
      add(194, "  }"),
      add(195, "  nurseryReset(&vm.nursery);"),
      ctx(196, "}"),
      "",
      tool("Task", "Audit every store for a missing barrier"),
      out("Done «d:(14 tool uses · 31.2k tokens · 1m 26s)»"),
      "",
      say("One miss: `closeUpvalues` writes into an old closure. Fixed."),
      "",
      busy("Bash", "make && ./run-tests --gc-stress"),
      out("«G:✓» {196..214} passed  «d:running test/gc/cycles.lox…»"),
      "",
      spin("Collecting", "12m 18s", "↓ 48.6k tokens"),
    ],
  },
  j: {
    dir: "~/oss/tiny-http", branch: "main", left: 91, mode: "welcome", grep: "parseRequest",
    files: ["src/parser.rs", "src/lib.rs"],
    log: [], first: "why is parseRequest so slow?",
  },
  k: {
    dir: "~/work/web/storefront", branch: "a11y-pass", left: 44, mode: "edits", grep: "aria-label",
    files: ["app/cart/page.tsx", "components/Button.tsx", "e2e/cart.spec.ts"],
    log: [
      you("fix everything axe reports on the cart"),
      "",
      tool("Task", "Run axe across every cart state"),
      out("«d:9 violations in 4 components»"),
      "",
      tool("Update", "components/Stepper.tsx"),
      out("Updated with «g:4» additions and «r:2» removals"),
      "",
      spin("Labelling", "4m 26s", "↓ 15k tokens"),
    ],
  },
  l: {
    dir: "~/k8s/charts/ingress", branch: "hpa", left: 6, mode: "compact", grep: "targetCPU",
    files: ["templates/hpa.yaml", "values.yaml", "templates/deployment.yaml"],
    log: [
      you("scale on request rate, not cpu"),
      "",
      tool("Bash", "helm template . | kubeconform"),
      out("«G:Summary:» 14 resources, 14 valid"),
      "",
      spin("Compacting conversation", "14s"),
    ],
  },
  m: {
    dir: "~/go/src/queue-worker", branch: "main", left: 69, mode: "done", grep: "visibilityTimeout",
    files: ["worker/pool.go", "worker/lease.go", "worker/pool_test.go"],
    log: [
      you("find the goroutine leak"),
      "",
      tool("Bash", "go test -race ./worker/..."),
      out("«G:ok»  queue-worker/worker  «d:4.218s»"),
      "",
      tool("Bash", "git push -u origin HEAD && gh pr create --fill"),
      out("«b:github.example/acme/queue-worker/pull/318»"),
      "",
      say("Lease renewers never stopped when a job was cancelled. They now exit on `ctx.Done()`. PR #318 is open and CI is green."),
      "",
      "«d:✻ Worked for 9m 41s»",
    ],
  },
  n: {
    dir: "~/research/protein-fold", branch: "contact-maps", left: 23, mode: "auto", grep: "distogram",
    files: ["model/evoformer.py", "data/msa.py", "train.py"],
    log: [
      you("loss goes NaN around step 4000"),
      "",
      tool("Bash", "python train.py --detect-anomaly"),
      out("«r:RuntimeError:» Function 'SqrtBackward0' returned nan"),
      "",
      say("`sqrt` of a zero distance on masked residues. Adding an epsilon."),
      "",
      busy("Bash", "python train.py --steps 6000"),
      out("«d:step {4210..4385}  loss 1.873  lr 3e-4»"),
      "",
      spin("Folding", "21m 09s", "↓ 33k tokens"),
    ],
  },
  o: {
    dir: "/srv/backups", branch: "", left: 95, mode: "ask", grep: "restic",
    files: ["nightly.sh", "excludes.txt"],
    ask: { title: "Bash command", cmd: "restic forget --keep-daily 7 --prune", why: "Prune old snapshots" },
    log: [
      you("the disk is at 94%, what can go?"),
      "",
      tool("Bash", "restic stats --mode raw-data"),
      out("Total Size: «y:1.82 TiB»  «d:in 411 snapshots»"),
      "",
      say("Nothing has been pruned since March. Keeping 7 dailies frees about 640 GiB."),
    ],
  },
  p: {
    dir: "~/design/tokens", branch: "dark-v3", left: 81, mode: "edits", grep: "surface-raised",
    files: ["tokens/color.json", "build/css.js"],
    log: [
      you("every text pair has to pass AA in dark mode"),
      "",
      tool("Bash", "node scripts/contrast.js"),
      out("«G:118 pass»  «R:7 fail»"),
      "",
      busy("Update", "tokens/color.json"),
      "",
      spin("Recolouring", "37s"),
    ],
  },
  q: {
    dir: "~/tmp/repro-4417", branch: "", left: 76, mode: "question", grep: "segfault",
    files: ["main.c", "Makefile"],
    log: [
      you("minimise this crash"),
      "",
      tool("Bash", "creduce ./check.sh main.c"),
      out("Reduced «y:9,412» lines to «G:23»"),
      "",
      say("Two candidates are left. Which compiler do you ship with?"),
    ],
    choices: ["clang 19", "gcc 14", "Both"],
  },
  r: {
    dir: "~/sec/audit-q4", branch: "findings", left: 35, mode: "plan", grep: "verify_signature",
    files: ["services/auth/jwt.py", "services/auth/session.py", "report/findings.md"],
    log: [
      you("review the auth service for token handling bugs"),
      "",
      tool("Task", "Trace every use of decode()"),
      out("Done «d:(22 tool uses · 44.0k tokens · 3m 02s)»"),
      tool("Task", "Check session fixation on login"),
      out("Done «d:(9 tool uses · 18.7k tokens · 1m 11s)»"),
      busy("Task", "Look for algorithm confusion"),
      out("«d:Read services/auth/keys.py»"),
      "",
      spin("Auditing", "7m 55s", "↓ 62k tokens"),
    ],
  },
  s: {
    dir: "~/dotfiles", branch: "main", left: 97, mode: "done", grep: "bindkey",
    files: [".zshrc", "nvim/init.lua", "tmux.conf"],
    log: [
      you("shell startup is slow"),
      "",
      tool("Bash", "zsh -xlic exit 2>&1 | ts -s | tail"),
      out("«y:nvm.sh» 612ms  «y:compinit» 188ms"),
      "",
      tool("Update", ".zshrc"),
      out("Updated with «g:5» additions and «r:1» removal"),
      "",
      say("Loading nvm lazily. Startup went from 910ms to «G:84ms»."),
      "",
      "«d:✻ Worked for 1m 16s»",
    ],
  },
  t: {
    dir: "~/sandbox/wasm-synth", branch: "reverb", left: 52, mode: "edits", grep: "AudioWorklet",
    files: ["src/dsp/reverb.rs", "web/worklet.js"],
    log: [
      you("clicks when the reverb tail is cut off"),
      "",
      say("The delay lines are cleared on note-off. They should fade out over 64 samples."),
      "",
      tool("Update", "src/dsp/reverb.rs"),
      out("Updated with «g:6» additions and «r:1» removal"),
      "",
      busy("Bash", "wasm-pack build --release"),
      "",
      spin("Reverberating", "1m 28s"),
    ],
  },
  u: {
    dir: "~/docs/handbook", branch: "onboarding", left: 66, mode: "edits", draft: "and the glossary", grep: "first week",
    files: ["onboarding/day-one.md", "onboarding/first-week.md"],
    log: [
      you("find every dead link and fix what you can"),
      "",
      tool("Bash", "lychee --no-progress '**/*.md'"),
      out("«G:1,204 OK»  «R:17 errors»  «y:3 redirects»"),
      "",
      busy("Update", "onboarding/first-week.md"),
      "",
      spin("Proofreading", "2m 44s", "↓ 5.3k tokens"),
    ],
  },
  v: {
    dir: "~/rust/ringbuf-lite", branch: "no-std", left: 29, mode: "error", grep: "MaybeUninit",
    files: ["src/lib.rs", "src/spsc.rs", "benches/throughput.rs"],
    log: [
      you("make this no_std and keep the benchmarks"),
      "",
      tool("Bash", "cargo build --no-default-features"),
      out("«G:Finished» «d:dev in 2.91s»"),
      "",
      tool("Bash", "cargo miri test spsc"),
      out("«G:test result: ok.» 41 passed"),
      "",
      "«r:⎿  API Error (overloaded) · Retrying in {8..1} seconds… (attempt 3/10)»",
      "",
      spin("Waiting", "5m 12s"),
    ],
  },
  w: {
    dir: "~/work/admin-portal", branch: "merge/main", left: 41, mode: "edits", grep: "<<<<<<<",
    files: ["src/routes/users.tsx", "src/api/client.ts", "package.json"],
    log: [
      you("merge main and sort out the conflicts"),
      "",
      tool("Bash", "git merge origin/main"),
      out("«r:CONFLICT» (content): src/routes/users.tsx"),
      more("«r:CONFLICT» (content): src/api/client.ts"),
      "",
      tool("Update", "src/routes/users.tsx"),
      out("Kept both the new filter and the paging"),
      "",
      busy("Update", "src/api/client.ts"),
      "",
      spin("Untangling", "3m 33s", "↓ 9.8k tokens"),
    ],
  },
  x: {
    dir: "~/blog", branch: "draft/gc-post", left: 84, mode: "done", grep: "draft: true",
    files: ["posts/generational-gc.md", "astro.config.mjs"],
    log: [
      you("turn my notes into a post, keep my voice"),
      "",
      tool("Write", "posts/generational-gc.md"),
      out("Wrote «g:186» lines"),
      "",
      tool("Bash", "npm run build"),
      out("«G:✓» 42 pages in 3.08s"),
      "",
      say("Draft is up at `/drafts/gc`."),
      "",
      "«d:✻ Worked for 2m 50s»",
    ],
  },
  y: {
    dir: "~/hw/keyboard-pcb", branch: "rev-c", left: 57, mode: "auto", grep: "footprint",
    files: ["kb.kicad_pcb", "scripts/place.py", "bom.csv"],
    log: [
      you("place the switches from the layout json"),
      "",
      tool("Bash", "python scripts/place.py layout.json"),
      out("Placed «G:68» switches, «G:68» diodes"),
      "",
      busy("Bash", "kicad-cli pcb drc kb.kicad_pcb"),
      out("«y:2» clearance warnings so far"),
      "",
      spin("Routing", "6m 02s", "↓ 12k tokens"),
    ],
  },
};

// ── fitting a transcript to a pane ────────────────────────────────────────
function cells(markup) {
  const out = [];
  for (const [c, t] of parse(markup)) for (const ch of t) out.push([ch, c]);
  return out;
}
function cellsHtml(row) {
  let html = "", run = "", cls = null;
  const flush = () => { if (run) html += cls ? `<i class="${cls}">${esc(run)}</i>` : esc(run); run = ""; };
  for (const [ch, c] of row) { if (c !== cls) { flush(); cls = c; } run += ch; }
  flush();
  return html;
}
/** A real terminal wraps rather than clips, and hangs the text under its marker. */
function wrap(line, cols) {
  const l = typeof line === "string" ? { t: line } : line;
  const all = l.n == null ? cells(l.t) : cells(l.t).slice(0, l.n);
  if (l.clip || all.length <= cols) return [{ cls: l.cls, html: cellsHtml(all.slice(0, cols)) }];
  let hang = 0;
  while (hang < all.length && all[hang][0] === " ") hang++;
  if ("●>⎿".includes(all[hang][0])) { hang += 2; while (all[hang][0] === " ") hang++; }
  const pad = Array.from({ length: hang }, () => [" ", ""]), rows = [];
  let rest = all;
  while (rest.length > cols) {
    let cut = cols;
    while (cut > hang + 1 && rest[cut][0] !== " ") cut--;
    if (cut <= hang + 1) cut = cols;
    rows.push(rest.slice(0, cut));
    rest = pad.concat(rest.slice(rest[cut]?.[0] === " " ? cut + 1 : cut));
  }
  rows.push(rest);
  return rows.map((r) => ({ cls: l.cls, html: cellsHtml(r) }));
}

const MODE_LINE = {
  // Not the real ⏵⏵ and ⏸: the fonts here have no such glyphs and draw boxes.
  edits: "«m:▸▸ accept edits on» «d:(shift+tab to cycle)»",
  auto: "«g:▸▸ auto mode on» «d:(shift+tab to cycle)»",
  plan: "«c:‖ plan mode on» «d:(shift+tab to cycle)»",
  ask: "«d:? for shortcuts»", done: "«d:? for shortcuts»", welcome: "«d:? for shortcuts»",
  question: "«d:enter to select · esc to cancel»",
  compact: "«d:? for shortcuts»", error: "«d:? for shortcuts»",
};

function footer(s, cols, st) {
  const rule = { cls: "ccrule", clip: 1, t: "─".repeat(cols) };
  const where = `«b:${s.dir}»` + (s.branch ? ` «d:on» «m:${s.branch}»` : "");
  const room = `«${st.left < 15 ? "r" : "d"}:${st.left}% left»`;
  const status = { clip: 1, t: where };
  const mode = { clip: 1, t: MODE_LINE[st.mode] };
  const gauge = { clip: 1, t: room };
  if (st.ask) return [
    rule,
    { clip: 1, t: `«w:${s.ask.title}»` },
    ...[`  ${s.ask.cmd}`, `  «d:${s.ask.why}»`],
    "«w:Do you want to proceed?»",
    "«cco:❯ 1. Yes»",
    "  2. Yes, and don't ask again",
    "  3. No «d:(esc)»",
    status,
  ];
  return [rule, { clip: 1, t: `«d:>» ${st.draft}§` }, rule, status, cols > 58 ? { clip: 1, t: MODE_LINE[st.mode] + "   " + room } : (st.left < 15 ? gauge : mode)];
}
function welcome(s) {
  return [
    "«cco:✻» «w:Welcome to Claude Code!»",
    "",
    `  «d:cwd:» ${s.dir}`,
    "",
    '«d:  Try "explain this codebase"»',
  ];
}

let cellW = 0;
function measureCell() {
  if (cellW) return cellW;
  const probe = document.createElement("span");
  probe.className = "ccterm";
  probe.style.cssText = "position:absolute;visibility:hidden;inset:auto";
  probe.textContent = "0".repeat(100);
  document.body.appendChild(probe);
  cellW = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return cellW;
}

// ── a session at one moment of its cycle ──────────────────────────────────
// `at` runs 0 to 1 over the pane's own cycle; `frame` is the film's. Everything
// periodic divides LOOP_FRAMES evenly, or it would hiccup where the video wraps.
function spinLine({ verb, took, extra }, at, frame) {
  const glyph = "✢✳✶✻✽"[Math.floor(frame / 3) % 5];
  const [, m, sec] = took.match(/(?:(\d+)m )?(\d+)s/);
  const total = (+m || 0) * 60 + +sec + Math.floor(at * 5);
  const clock = total >= 60 ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
  const more = extra.replace(/([\d.]+)k/, (_, n) => (+n + at * 0.7).toFixed(1) + "k");
  return { clip: 1, t: `«cco:${glyph} ${verb}…» «d:(${clock}${more ? " · " + more : ""} · esc to interrupt)»` };
}
const typed = (text, at, from, to) => text.slice(0, Math.floor(text.length * clamp((at - from) / (to - from))));

function moment(s, at, frame) {
  const st = { mode: s.mode, ask: false, draft: typed(s.draft || "", at, 0.2, 0.7), left: s.left - Math.floor(at * 2) };
  let log = s.log.slice(), tail = null;
  const last = log[log.length - 1];
  if (last && last.spin) tail = log.pop();

  if (s.mode === "welcome") {
    const sent = at >= 0.62;
    st.draft = sent ? "" : typed(s.first, at, 0.14, 0.56);
    log = welcome(s);
    if (sent) log.push(you(s.first), "", busy("Search", 'pattern: "parseRequest"'));
    tail = sent ? spin("Exploring", "1s") : null;
  } else if (s.mode === "done") {
    const worked = log.pop();
    tail = at < 0.84 ? spin("Finishing up", "8s") : worked;
  } else if (s.mode === "compact" && at >= 0.72) {
    tail = "«d:✻ Conversation compacted»";
    st.left = 71;
  } else if (s.ask) {
    st.ask = at < 0.62;
    if (!st.ask) { log.push("", busy("Bash", s.ask.cmd)); tail = spin("Running", "1s"); }
  } else if (s.choices) {
    if (at < 0.68) {
      const pick = at < 0.36 ? 0 : 1;
      log.push("", ...s.choices.map((c, i) => (i === pick ? `  «cco:❯ ${i + 1}.» ${c}` : `    ${i + 1}. ${c}`)));
    } else {
      log.push("", you(s.choices[1]), "", busy("Bash", "gcc-14 -O2 -fsanitize=address main.c"));
      tail = spin("Bisecting", "2s");
      st.mode = "edits";
    }
  }

  // The newest few entries arrive during the cycle, and an agent's own sentences
  // are written out rather than appearing whole. Welcome and answered prompts
  // have just been composed above and need none of this.
  const scripted = s.mode !== "welcome";
  const hidden = scripted ? (s.reveal ?? Math.min(6, Math.floor(s.log.length / 2))) : 0;
  const first = log.length - hidden, lines = [];
  log.forEach((l, i) => {
    let shown = l;
    if (i >= first && i < s.log.length) {
      const due = 0.06 + (0.7 * (i - first)) / hidden;
      if (at < due) return;
      if (typeof l === "string" && l.startsWith("«w:●»")) shown = { t: l, n: 4 + Math.floor((at - due) * 420) };
    }
    lines.push(shown);
  });
  if (tail) lines.push("", tail.spin ? spinLine(tail.spin, at, frame) : tail);
  return { st, lines };
}
function live(line, at, frame) {
  const l = typeof line === "string" ? { t: line } : { ...line };
  l.t = l.t.replace(/\{(\d+)\.\.(\d+)\}/g, (_, a, b) => String(Math.round(lerp(+a, +b, at))));
  if (Math.floor(frame / 15) % 2) l.t = l.t.replace("«cco:●»", "«d:●»");
  return l;
}

BODIES.cc = function (p, w, h, frame) {
  const s = SESSIONS[p.c], cols = Math.floor((w - 16) / measureCell()), rows = Math.floor((h - 8) / CC_ROW_PX);
  const at = ((frame + p.offset) % LOOP_FRAMES) / LOOP_FRAMES;
  const { st, lines } = moment(s, at, frame);
  const lay = (ls) => ls.flatMap((l) => (l === "" ? [{ html: "" }] : wrap(live(l, at, frame), cols)));
  const foot = lay(footer(s, cols, st));
  const room = rows - foot.length;
  // Always there rather than added to fit, so a pane's history does not change
  // underneath it as new lines push the old ones up.
  const past = s.mode === "welcome" ? [] : lay(earlier(s, room + 2));
  const shown = past.concat(lay(lines)).slice(-room);
  while (shown.length < room) shown.push({ html: "" });
  const caret = p.focus && frame % 30 < 18 ? '<b class="cur"></b>' : '<b class="cur off"></b>';
  const html = shown.concat(foot).map((r) => `<div${r.cls ? ` class="${r.cls}"` : ""}>${(r.html || " ").replace("§", caret)}</div>`).join("");
  return `<div class="ccterm">${html}</div>`;
};

// ── the window ────────────────────────────────────────────────────────────
// Five columns of tmux-style splits. The middle one is wider and carries the
// big pane; the rest are as small as they can be and stay usable.
const LAYOUT = ["h", [0.185, 0.185, 0.26, 0.185, 0.185],
  ["v", [0.27, 0.25, 0.26, 0.22], "a", "b", "c", "d"],
  ["v", [0.2, 0.22, 0.19, 0.2, 0.19], "e", "f", "g", "h", "j"],
  ["v", [0.5, 0.25, 0.25], "i", ["h", [0.5, 0.5], "k", "l"], ["h", [0.5, 0.5], "m", "q"]],
  ["v", [0.21, 0.2, 0.2, 0.2, 0.19], "n", "o", "p", "r", "s"],
  ["v", [0.2, 0.2, 0.21, 0.19, 0.2], "t", "u", "v", "w", ["h", [0.5, 0.5], "x", "y"]],
];
// A few panes dressed in their own theme, which jterm allows per pane, so that
// the wall of terminals has some landmarks in it.
const DRESSED = { c: "tokyo", g: "gruvbox", l: "dracula", o: "nord", t: "mocha", w: "kanagawa", n: "rosepine" };

window.paintMultitask = function (W, H) {
  const style = document.createElement("style");
  style.textContent = `
    html, body, #cam { width: ${W}px !important; height: ${H}px !important; }
    .ccterm { position: absolute; inset: 4px 8px; overflow: hidden; color: var(--fg); white-space: pre;
              font: ${CC_FONT_PX}px/${CC_ROW_PX}px var(--mono); }
    .ccterm > div { height: ${CC_ROW_PX}px; overflow: hidden; }
    .ccterm .cco { color: #d97757; }
    .ccterm .ccrule { color: var(--t4); }
    .ccterm .ccyou { color: var(--t2); }
    .ccterm .ccadd { background: color-mix(in srgb, var(--g) 20%, transparent); }
    .ccterm .ccdel { background: color-mix(in srgb, var(--r) 22%, transparent); }
    .ccterm .cur { width: 7px; height: 13px; vertical-align: -2px; }`;
  document.head.appendChild(style);

  const panes = {};
  Object.keys(SESSIONS).forEach((id, i) => {
    panes[id] = { k: "cc", c: id, icon: "bot", title: SESSIONS[id].dir, theme: DRESSED[id], focus: id === "i", offset: Math.floor(hash(i * 3.7 + 1) * LOOP_FRAMES) };
  });
  const scene = {
    W, H, theme: "dark", panes, focus: "i",
    rects: rects(LAYOUT, { x: 0, y: 0, w: W, h: H - 34 }),
    tabs: [{ title: `${SESSIONS.i.dir} +${Object.keys(panes).length - 1}`, icon: "bot" }, { title: "~/work" }, { title: "staging logs" }, { title: "notes.md", icon: "file" }],
  };
  window.paintFrame = (frame) => { document.getElementById("ui").innerHTML = winHtml(scene, frame); };
  paintFrame(0);
  return Object.keys(panes).length;
};

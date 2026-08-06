#!/usr/bin/env node
/**
 * Set the version in all three places at once.
 *
 * They have to agree — the tag names the release, `tauri.conf.json` names the
 * installers, and Cargo names the binary — and keeping three files in step by
 * hand is exactly the kind of thing that is wrong one release in four.
 *
 *     npm run version 1.2.3
 */

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: set-version.mjs <major.minor.patch>");
  process.exit(2);
}

function editJson(path, apply) {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text);
  apply(data);
  // Re-serialised rather than patched textually, then given back the trailing
  // newline the file had.
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

editJson("package.json", (data) => {
  data.version = version;
});
editJson("src-tauri/tauri.conf.json", (data) => {
  data.version = version;
});

// Cargo.toml is edited textually and only on the first `version =`, which is
// the package's own — the dependency versions below it must not move.
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
writeFileSync(
  "src-tauri/Cargo.toml",
  cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
);

console.log(`Set version ${version}. Commit, then: git tag v${version} && git push --follow-tags`);

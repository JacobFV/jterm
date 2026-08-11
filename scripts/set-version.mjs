#!/usr/bin/env node
/**
 * Set the version everywhere it is written down.
 *
 * Three of these have to agree or CI refuses the tag — the tag names the
 * release, `tauri.conf.json` names the installers, and Cargo names the binary —
 * and keeping them in step by hand is exactly the kind of thing that is wrong
 * one release in four.
 *
 * The two lockfiles are the quiet ones. Nothing checks them, nothing fails when
 * they disagree, and `package-lock.json` was still saying 0.1.0 two releases
 * later because of it. They are here so that stops happening; a lockfile that
 * has drifted is a small lie in the one file that is supposed to be exact.
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

// npm records the root version twice, at the top of the lockfile and again in
// the entry for the root package itself. Both, or `npm ci` is reading one of
// each.
editJson("package-lock.json", (data) => {
  data.version = version;
  if (data.packages?.[""]) data.packages[""].version = version;
});

// Cargo.toml is edited textually and only on the first `version =`, which is
// the package's own — the dependency versions below it must not move.
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
writeFileSync(
  "src-tauri/Cargo.toml",
  cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
);

// Cargo.lock has one entry for this crate among several hundred for everything
// else, so the name is what finds it and only the line after it moves.
const lock = readFileSync("src-tauri/Cargo.lock", "utf8");
writeFileSync(
  "src-tauri/Cargo.lock",
  lock.replace(/(name = "jterm"\nversion = )"[^"]+"/, `$1"${version}"`),
);

console.log(`Set version ${version}. Commit, then: git tag v${version} && git push --follow-tags`);

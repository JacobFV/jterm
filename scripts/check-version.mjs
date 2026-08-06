#!/usr/bin/env node
/**
 * Fail if the tag being released and the three files that claim a version
 * disagree.
 *
 * Run first in the release workflow, before four platforms spend twenty minutes
 * building something whose `.msi` will be named after the wrong version.
 */

import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: check-version.mjs <tag>");
  process.exit(2);
}

const expected = tag.replace(/^v/, "");

const found = {
  "package.json": JSON.parse(readFileSync("package.json", "utf8")).version,
  "src-tauri/tauri.conf.json": JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
    .version,
  "src-tauri/Cargo.toml": (readFileSync("src-tauri/Cargo.toml", "utf8").match(
    /^version\s*=\s*"([^"]+)"/m,
  ) ?? [])[1],
};

const wrong = Object.entries(found).filter(([, version]) => version !== expected);

if (wrong.length > 0) {
  console.error(`Tag ${tag} means version ${expected}, but:`);
  for (const [file, version] of wrong) {
    console.error(`  ${file}: ${version ?? "not found"}`);
  }
  console.error("\nRun `npm run version " + expected + "` and commit before tagging.");
  process.exit(1);
}

console.log(`All three version declarations agree with ${tag}.`);

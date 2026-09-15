#!/usr/bin/env node
/**
 * Give the updater a signed `.deb` and `.rpm` to install.
 *
 * The updater plugin can update a copy of jterm installed from a `.deb` or an
 * `.rpm` — it hands the new package to the package manager behind the desktop's
 * password prompt — but it looks for that package in `latest.json` under
 * `linux-<arch>-deb` / `linux-<arch>-rpm`, and it will only install one whose
 * signature checks out. The bundler signs only the formats it replaces itself
 * (AppImage, `.app`, `.msi`, NSIS), so neither the signatures nor the entries
 * exist, and a deb install would fall back to the AppImage entry and refuse it
 * as the wrong format. This fills the gap once every platform has built.
 *
 *     sign-linux-packages.mjs <dir> <download-base-url>
 *
 * `<dir>` holds the release's packages and its `latest.json`. Each package is
 * signed with the key in `TAURI_SIGNING_PRIVATE_KEY` — the same key, so the
 * same public key in `tauri.conf.json` verifies it — and `latest.json` gains an
 * entry per package, pointing at `<download-base-url>/<file>`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, base] = process.argv.slice(2);
if (!dir || !base) {
  console.error("usage: sign-linux-packages.mjs <dir> <download-base-url>");
  process.exit(2);
}

/** The updater's name for a package's platform, or `null` for anything else. */
function platformKey(name) {
  const deb = name.match(/_(amd64|arm64)\.deb$/);
  if (deb) return `linux-${deb[1] === "amd64" ? "x86_64" : "aarch64"}-deb`;
  const rpm = name.match(/\.(x86_64|aarch64)\.rpm$/);
  if (rpm) return `linux-${rpm[1]}-rpm`;
  return null;
}

const manifestPath = join(dir, "latest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.platforms ??= {};

const packages = readdirSync(dir).filter((name) => platformKey(name) !== null);
if (packages.length === 0) {
  console.error(`No .deb or .rpm packages in ${dir}.`);
  process.exit(1);
}

for (const name of packages) {
  const path = join(dir, name);
  // The CLI rather than a reimplementation of minisign: it is what signed every
  // other artifact in the release, so the signatures cannot disagree in format.
  execFileSync("npx", ["tauri", "signer", "sign", path], { stdio: "inherit" });
  manifest.platforms[platformKey(name)] = {
    signature: readFileSync(`${path}.sig`, "utf8"),
    url: `${base}/${encodeURIComponent(name)}`,
  };
  console.log(`${platformKey(name)} → ${name}`);
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

#!/usr/bin/env node
/* global process, console */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const BUNDLE = path.join(ROOT, "plugin-bundle");
const manifestPath = path.join(BUNDLE, "drop-plugin.json");

// sidecars/<os>-<arch>/gse-engine(.exe) built by the release workflow.
const SIDE_CARS = [
  {
    os: "linux",
    arch: "x64",
    path: "sidecars/linux-x64/gse-engine",
  },
  {
    os: "windows",
    arch: "x64",
    path: "sidecars/windows-x64/gse-engine.exe",
  },
  {
    os: "macos",
    arch: "arm64",
    path: "sidecars/macos-arm64/gse-engine",
  },
];

const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

manifest.client.commands = manifest.client.commands?.slice() ?? [];
if (!manifest.client.commands.includes("gse-engine")) {
  manifest.client.commands.push("gse-engine");
}

const targets = [];
for (const { os, arch, path: rel } of SIDE_CARS) {
  const abs = path.join(BUNDLE, rel);
  if (!existsSync(abs)) {
    console.error(`Missing sidecar binary: ${rel}. Build engines first.`);
    process.exit(1);
  }
  const bytes = await readFile(abs);
  targets.push({
    os,
    arch,
    path: rel,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

manifest.client.sidecars = [{ name: "gse-engine", targets }];

writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `updated ${path.relative(ROOT, manifestPath)} with ${targets.length} sidecar target(s)`,
);

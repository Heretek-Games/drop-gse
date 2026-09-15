import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DropGseServerPlugin } from "../src/index.js";

// npm runs workspace scripts from the package directory.
const manifestPath = path.join(process.cwd(), "../../plugin-bundle/drop-plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  capabilities: string[];
  server: { capabilities: string[] };
  client: { capabilities: string[] };
};

test("shipped manifest server capabilities match the server plugin", () => {
  const declared = new Set(manifest.server.capabilities);
  const required = new DropGseServerPlugin().metadata.capabilities as string[];

  const missing = required.filter((capability) => !declared.has(capability));
  assert.deepEqual(missing, [], `manifest.server.capabilities is missing: ${missing.join(", ")}`);

  const extra = manifest.server.capabilities.filter((capability) => !required.includes(capability));
  assert.deepEqual(extra, [], `manifest.server.capabilities declares unused: ${extra.join(", ")}`);
});

test("manifest top-level capabilities equals the server+client union", () => {
  const union = new Set([...manifest.server.capabilities, ...manifest.client.capabilities]);
  assert.deepEqual([...manifest.capabilities].sort(), [...union].sort());
});

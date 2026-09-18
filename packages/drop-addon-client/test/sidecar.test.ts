import test from "node:test";
import assert from "node:assert/strict";
import { MockSystemCommand } from "@droposs/plugin-sdk";
import { GseSidecar, EXPECTED_SIDECAR_VERSION } from "../src/sidecar.js";

test("GseSidecar.isAvailable returns true when engine version probe succeeds", async () => {
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["version"], {
    code: 0,
    stdout: JSON.stringify({ engine: "gse-engine", version: EXPECTED_SIDECAR_VERSION }),
    stderr: "",
  });

  const sidecar = new GseSidecar(system);
  assert.equal(await sidecar.isAvailable(), true);
  // Second call within TTL uses cached result
  assert.equal(await sidecar.isAvailable(), true);
  assert.equal(system.calls.length, 1);
});

test("GseSidecar.isAvailable returns false when system is undefined or probe fails", async () => {
  const noSystem = new GseSidecar(undefined);
  assert.equal(await noSystem.isAvailable(), false);

  const systemErr = new MockSystemCommand();
  systemErr.setResponse("gse-engine", ["version"], {
    code: 1,
    stdout: "",
    stderr: "command not found",
  });
  const sidecarErr = new GseSidecar(systemErr);
  assert.equal(await sidecarErr.isAvailable(), false);

  const systemBadJson = new MockSystemCommand();
  systemBadJson.setResponse("gse-engine", ["version"], {
    code: 0,
    stdout: "not-json",
    stderr: "",
  });
  const sidecarBadJson = new GseSidecar(systemBadJson);
  assert.equal(await sidecarBadJson.isAvailable(), false);

  const systemWrongEngine = new MockSystemCommand();
  systemWrongEngine.setResponse("gse-engine", ["version"], {
    code: 0,
    stdout: JSON.stringify({ engine: "other-tool", version: "1.0.0" }),
    stderr: "",
  });
  const sidecarWrongEngine = new GseSidecar(systemWrongEngine);
  assert.equal(await sidecarWrongEngine.isAvailable(), false);
});

test("GseSidecar.isAvailable rejects a sidecar reporting a different version", async () => {
  // A rogue PATH-local binary claiming to be gse-engine but with an older version
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["version"], {
    code: 0,
    stdout: JSON.stringify({ engine: "gse-engine", version: "0.1.0" }),
    stderr: "",
  });
  const sidecar = new GseSidecar(system);
  assert.equal(await sidecar.isAvailable(), false);
});

test("GseSidecar.isAvailable re-probes after resetAvailability clears the cache", async () => {
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["version"], {
    code: 0,
    stdout: JSON.stringify({ engine: "gse-engine", version: EXPECTED_SIDECAR_VERSION }),
    stderr: "",
  });
  const sidecar = new GseSidecar(system);

  assert.equal(await sidecar.isAvailable(), true);
  assert.equal(system.calls.length, 1); // one probe so far

  // Within TTL — no additional probe
  assert.equal(await sidecar.isAvailable(), true);
  assert.equal(system.calls.length, 1);

  // Reset clears the cache, forcing a fresh probe on next call
  sidecar.resetAvailability();
  assert.equal(await sidecar.isAvailable(), true);
  assert.equal(system.calls.length, 2); // probed again
});

test("GseSidecar.scan invokes gse-engine scan and parses result", async () => {
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["scan", "/games/portal2"], {
    code: 0,
    stdout: JSON.stringify({
      gameDir: "/games/portal2",
      targets: ["bin/steam_api.dll"],
      antiCheat: null,
    }),
    stderr: "",
  });

  const sidecar = new GseSidecar(system);
  const result = await sidecar.scan("/games/portal2");
  assert.equal(result.gameDir, "/games/portal2");
  assert.deepEqual(result.targets, ["bin/steam_api.dll"]);
  assert.equal(result.antiCheat, null);

  assert.equal(system.calls.length, 1);
  assert.equal(system.calls[0]?.bin, "gse-engine");
  assert.deepEqual(system.calls[0]?.args, ["scan", "/games/portal2"]);
});

test("GseSidecar.scan throws fail-closed on process failure", async () => {
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["scan", "/games/unreadable"], {
    code: 1,
    stdout: "",
    stderr: "anti-cheat scan exceeded the maximum depth",
  });

  const sidecar = new GseSidecar(system);
  await assert.rejects(
    sidecar.scan("/games/unreadable"),
    /gse-engine scan failed: anti-cheat scan exceeded the maximum depth/,
  );
});

test("GseSidecar.patch passes CLI arguments and parses report", async () => {
  const system = new MockSystemCommand();
  system.setResponse(
    "gse-engine",
    [
      "patch",
      "--game-dir",
      "/games/spacewar",
      "--app-id",
      "480",
      "--emulator-dir",
      "/emulators/goldberg",
      "--flavor",
      "gse",
      "--targets",
      "steam_api64.dll",
      "--peers",
      "10.242.1.2,10.242.1.3",
    ],
    {
      code: 0,
      stdout: JSON.stringify({
        patched: ["steam_api64.dll"],
        backedUp: ["steam_api64.dll"],
      }),
      stderr: "",
    },
  );

  const sidecar = new GseSidecar(system);
  const result = await sidecar.patch({
    gameDir: "/games/spacewar",
    appId: 480,
    emulatorDir: "/emulators/goldberg",
    flavor: "gse_fork",
    targets: ["steam_api64.dll"],
    peers: ["10.242.1.2", "10.242.1.3"],
  });

  assert.deepEqual(result.patched, ["steam_api64.dll"]);
  assert.deepEqual(result.backedUp, ["steam_api64.dll"]);
});

test("GseSidecar.restore passes arguments and parses result", async () => {
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["restore", "--game-dir", "/games/spacewar"], {
    code: 0,
    stdout: JSON.stringify({
      restored: ["steam_api64.dll"],
    }),
    stderr: "",
  });

  const sidecar = new GseSidecar(system);
  const result = await sidecar.restore({ gameDir: "/games/spacewar" });
  assert.deepEqual(result.restored, ["steam_api64.dll"]);
});

test("GseSidecar.extractInterfaces parses interface identifiers", async () => {
  const system = new MockSystemCommand();
  system.setResponse("gse-engine", ["interfaces", "/games/spacewar/steam_api64.dll"], {
    code: 0,
    stdout: JSON.stringify({
      interfaces: ["SteamUser021", "SteamFriends017"],
    }),
    stderr: "",
  });

  const sidecar = new GseSidecar(system);
  const interfaces = await sidecar.extractInterfaces("/games/spacewar/steam_api64.dll");
  assert.deepEqual(interfaces, ["SteamUser021", "SteamFriends017"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { MockClientPluginContext, type LaunchHook } from "@droposs/plugin-sdk";
import {
  ACTIVE_ROOM_KEY,
  ACHIEVEMENTS_DEFINITIONS_FILE,
  ACHIEVEMENTS_KNOWN_KEY_PREFIX,
  ACHIEVEMENTS_UNLOCK_PATH,
  CUSTOM_BROADCASTS_FILE,
  DropGseClientPlugin,
  EXPECTED_SIDECAR_VERSION,
  PORTABLE_SAVE_CONFIG_FILE,
  STEAM_APPID_FILE,
  STEAM_SETTINGS_APPID_FILE,
  STEAM_SETTINGS_BROADCASTS_FILE,
  STEAM_SETTINGS_INI,
  STEAM_SETTINGS_INTERFACES_FILE,
  STEAM_SETTINGS_MAIN_INI,
  sanitizeConfigValue,
  type ActiveRoom,
  type MemberRoom,
} from "../src/index.js";

const LAUNCH = {
  gameId: "42",
  gameTitle: "Test Game",
  gameDir: "/games/42",
};

function makeRoom(overrides: Partial<MemberRoom> = {}): MemberRoom {
  return {
    id: "r1",
    gameId: "42",
    versionId: "v1",
    appId: 480,
    memberCount: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hostUserId: "u1",
    members: [
      { userId: "u1", meshAddress: "10.242.1.20", joinedAt: 1 },
      { userId: "u2", meshAddress: "10.242.1.21", joinedAt: 2 },
    ],
    mesh: { backend: "zerotier", cidr: "10.242.1.0/24", networkId: "n1" },
    ...overrides,
  };
}

function activeRoom(): ActiveRoom {
  return {
    roomId: "r1",
    gameId: "42",
    versionId: "v1",
    appId: 480,
    peers: ["10.242.1.20", "10.242.1.21"],
    expiresAt: Date.now() + 60_000,
  };
}

function hook(ctx: MockClientPluginContext, stage: string): LaunchHook {
  const found = ctx.launchHooks.find((h) => h.stage === stage);
  assert.ok(found, `expected a ${stage} launch hook`);
  return found;
}

test("DropGseClientPlugin initializes and registers its surfaces", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);

  assert.equal(ctx.playActionProviders.length, 1);
  assert.ok(ctx.registeredSlots.has("game-detail:actions"));
  assert.ok(hook(ctx, "pre-launch:validate"));
  assert.ok(hook(ctx, "pre-launch:stage"));
  assert.ok(hook(ctx, "pre-launch:network-post"));
  assert.ok(hook(ctx, "post-exit:restore"));
});

test("play actions are discovered and joining persists the active room", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);

  ctx.serverRequestLog.setResponse("GET", "/rooms?gameId=42", {
    rooms: [makeRoom()],
  });
  ctx.serverRequestLog.setResponse("POST", "/rooms/r1/join", {
    room: makeRoom(),
  });

  const actions = await ctx.resolvePlayActions("42");
  assert.equal(actions.length, 2);
  const hostAction = actions.find((a) => a.id === "gse-host-42");
  const joinAction = actions.find((a) => a.id === "gse-join-r1");
  assert.ok(hostAction);
  assert.ok(joinAction);
  assert.match(hostAction.name, /Host GSE Multiplayer Room/);
  assert.match(joinAction.name, /Join GSE room/);

  await joinAction.execute(LAUNCH);

  const calls = ctx.serverRequestLog.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(calls, ["GET /rooms?gameId=42", "POST /rooms/r1/join"]);

  const stored = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  assert.equal(stored?.roomId, "r1");
  assert.deepEqual(stored?.peers, ["10.242.1.20", "10.242.1.21"]);
});

test("host action creates a room and persists the active room", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);

  ctx.serverRequestLog.setResponse("GET", "/rooms?gameId=42", {
    rooms: [],
  });
  ctx.serverRequestLog.setResponse("POST", "/rooms", {
    room: makeRoom({
      id: "r-new",
      members: [{ userId: "u1", meshAddress: "10.242.1.50", joinedAt: 1 }],
    }),
  });

  const actions = await ctx.resolvePlayActions("42");
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.id, "gse-host-42");
  assert.match(actions[0]!.name, /Host GSE Multiplayer Room/);

  await actions[0]!.execute(LAUNCH);

  const calls = ctx.serverRequestLog.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(calls, ["GET /rooms?gameId=42", "POST /rooms"]);

  const stored = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  assert.equal(stored?.roomId, "r-new");
  assert.equal(stored?.isHost, true);
  assert.deepEqual(stored?.peers, ["10.242.1.50"]);
});

test("anti-cheat detection aborts the launch pipeline", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  const plugin = new DropGseClientPlugin();
  await plugin.init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  ctx.gameScanner.mockInstalledFiles = ["EasyAntiCheat/EasyAntiCheat.exe"];

  await assert.rejects(
    () => Promise.resolve(hook(ctx, "pre-launch:validate").execute(LAUNCH)),
    /GSE multiplayer aborted/,
  );
});

test("anti-cheat detection falls back to a legacy checkAntiCheat host", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  const plugin = new DropGseClientPlugin();
  await plugin.init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  // Simulate a pre-findFiles host: hide the generic capability and expose the
  // legacy checkAntiCheat method instead.
  const scanner = ctx.gameScanner as unknown as {
    findFiles?: (gameId: string, patterns: string[]) => Promise<string[]>;
    checkAntiCheat?: (gameId: string) => Promise<{
      detected: boolean;
      binaries?: string[];
    }>;
  };
  scanner.findFiles = undefined;
  scanner.checkAntiCheat = async () => ({
    detected: true,
    binaries: ["EasyAntiCheat/EasyAntiCheat.exe"],
  });

  await assert.rejects(
    () => Promise.resolve(hook(ctx, "pre-launch:validate").execute(LAUNCH)),
    /GSE multiplayer aborted/,
  );
});

test("stage backs up binaries and writes confined emulator config", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  const original = new TextEncoder().encode("original-steam-api");
  ctx.gameFs.files.set("42:steam_api64.dll", original);

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);

  assert.ok(ctx.gameFs.files.has("42:steam_api64.dll.drop-backup"));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_MAIN_INI}`));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_APPID_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_BROADCASTS_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_APPID_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_INI}`));

  const broadcasts = new TextDecoder().decode(
    ctx.gameFs.files.get(`42:${CUSTOM_BROADCASTS_FILE}`)!,
  );
  assert.equal(broadcasts.trim(), "10.242.1.20\n10.242.1.21");

  const settingsBroadcasts = new TextDecoder().decode(
    ctx.gameFs.files.get(`42:${STEAM_SETTINGS_BROADCASTS_FILE}`)!,
  );
  assert.equal(settingsBroadcasts.trim(), "10.242.1.20:47584\n10.242.1.21:47584");

  const mainIni = new TextDecoder().decode(ctx.gameFs.files.get(`42:${STEAM_SETTINGS_MAIN_INI}`)!);
  assert.match(mainIni, /listener_port=47584/);
});

test("stage extracts interface identifiers from binary bytes", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  const binaryWithInterfaces = new TextEncoder().encode(
    "MZ\x00SteamUser021\x00SteamNetworkingSockets012\x00SteamUser021\x00extra",
  );
  ctx.gameFs.files.set("42:steam_api64.dll", binaryWithInterfaces);

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);

  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_INTERFACES_FILE}`));
  const interfaces = new TextDecoder().decode(
    ctx.gameFs.files.get(`42:${STEAM_SETTINGS_INTERFACES_FILE}`)!,
  );
  assert.equal(interfaces, "SteamNetworkingSockets012\nSteamUser021\n");
});

test("post-exit restore returns the original binary and removes config", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  const original = new TextEncoder().encode("original-steam-api");
  ctx.gameFs.files.set("42:steam_api64.dll", original);

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);
  ctx.gameFs.files.set("42:steam_api64.dll", new TextEncoder().encode("patched"));

  await hook(ctx, "post-exit:restore").execute(LAUNCH);

  assert.equal(
    new TextDecoder().decode(ctx.gameFs.files.get("42:steam_api64.dll")),
    "original-steam-api",
  );
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_MAIN_INI}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_APPID_FILE}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_BROADCASTS_FILE}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_APPID_FILE}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`), false);
  assert.equal(await ctx.storage.get(ACTIVE_ROOM_KEY), null);

  // Verifies room teardown call was dispatched to server
  assert.ok(
    ctx.serverRequestLog.calls.some((c) => c.method === "DELETE" && c.path === "/rooms/r1"),
  );
});

test("network-post refreshes custom_broadcasts with newly assigned mesh addresses", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  // Stage-3 bootstrap state: only the launching client had an address so far.
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  ctx.serverRequestLog.setResponse("GET", "/rooms/r1", {
    room: makeRoom({
      members: [
        { userId: "u1", meshAddress: "10.242.1.20", joinedAt: 1 },
        { userId: "u2", meshAddress: "10.242.1.21", joinedAt: 2 },
        { userId: "u3", meshAddress: "10.242.1.22", joinedAt: 3 },
      ],
    }),
  });

  await hook(ctx, "pre-launch:network-post").execute(LAUNCH);

  assert.ok(ctx.serverRequestLog.calls.some((c) => c.method === "GET" && c.path === "/rooms/r1"));

  const broadcasts = new TextDecoder().decode(
    ctx.gameFs.files.get(`42:${CUSTOM_BROADCASTS_FILE}`)!,
  );
  assert.equal(broadcasts, "10.242.1.20\n10.242.1.21\n10.242.1.22\n");

  const settingsBroadcasts = new TextDecoder().decode(
    ctx.gameFs.files.get(`42:${STEAM_SETTINGS_BROADCASTS_FILE}`)!,
  );
  assert.equal(settingsBroadcasts, "10.242.1.20:47584\n10.242.1.21:47584\n10.242.1.22:47584\n");

  const settingsIni = new TextDecoder().decode(ctx.gameFs.files.get(`42:${STEAM_SETTINGS_INI}`)!);
  assert.match(settingsIni, /peer_count=3/);

  const stored = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  assert.deepEqual(stored?.peers, ["10.242.1.20", "10.242.1.21", "10.242.1.22"]);
});

test("network-post keeps the staged broadcast list when no new addresses appeared", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  ctx.serverRequestLog.setResponse("GET", "/rooms/r1", { room: makeRoom() });

  await hook(ctx, "pre-launch:network-post").execute(LAUNCH);

  assert.equal(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_BROADCASTS_FILE}`), false);

  const stored = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  assert.deepEqual(stored?.peers, ["10.242.1.20", "10.242.1.21"]);
});

test("network-post is best-effort when the room is unavailable", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  // No canned response: the route resolves empty, so the staged list is kept.

  await hook(ctx, "pre-launch:network-post").execute(LAUNCH);

  assert.equal(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`), false);
  const stored = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  assert.deepEqual(stored?.peers, ["10.242.1.20", "10.242.1.21"]);
});

test("full launch pipeline has refreshed broadcasts on disk at spawn time", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  ctx.serverRequestLog.setResponse("GET", "/rooms/r1", {
    room: makeRoom({
      members: [
        { userId: "u1", meshAddress: "10.242.1.20", joinedAt: 1 },
        { userId: "u2", meshAddress: "10.242.1.21", joinedAt: 2 },
        { userId: "u3", meshAddress: "10.242.1.22", joinedAt: 3 },
      ],
    }),
  });

  // launchFn runs after every pre-launch stage (stage -> network ->
  // network-post) and before post-exit teardown, so assertions made inside it
  // see exactly what the spawned game process would see.
  let broadcastsAtSpawn = "";
  let iniAtSpawn = "";
  await ctx.executeLaunchPipeline(LAUNCH, async () => {
    broadcastsAtSpawn = new TextDecoder().decode(
      ctx.gameFs.files.get(`42:${CUSTOM_BROADCASTS_FILE}`) ?? new Uint8Array(),
    );
    iniAtSpawn = new TextDecoder().decode(
      ctx.gameFs.files.get(`42:${STEAM_SETTINGS_INI}`) ?? new Uint8Array(),
    );
  });

  assert.match(broadcastsAtSpawn, /10\.242\.1\.22/);
  assert.match(iniAtSpawn, /peer_count=3/);
});

const DEFINITIONS = JSON.stringify([{ name: "ACH_A" }, { name: "ACH_B" }]);

function writeDefinitions(ctx: MockClientPluginContext): void {
  ctx.gameFs.files.set(
    `42:${ACHIEVEMENTS_DEFINITIONS_FILE}`,
    new TextEncoder().encode(DEFINITIONS),
  );
}

function writeGameFile(ctx: MockClientPluginContext, path: string, json: string): void {
  ctx.gameFs.files.set(`42:${path}`, new TextEncoder().encode(json));
}

function unlockCalls(ctx: MockClientPluginContext) {
  return ctx.serverRequestLog.calls.filter(
    (call) => call.method === "POST" && call.path === ACHIEVEMENTS_UNLOCK_PATH,
  );
}

test("post-exit reports newly earned achievements to the core unlock endpoint", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  writeDefinitions(ctx);

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);
  assert.ok(ctx.gameFs.files.has(`42:${PORTABLE_SAVE_CONFIG_FILE}`));

  writeGameFile(
    ctx,
    "gse_saves/480/achievements.json",
    JSON.stringify({
      ACH_A: { earned: false, earned_time: 0 },
      ACH_B: { earned: true, earned_time: 42 },
    }),
  );

  await hook(ctx, "post-exit:restore").execute(LAUNCH);

  assert.deepEqual(
    unlockCalls(ctx).map((call) => call.body),
    [{ gameId: "42", key: "ACH_B" }],
  );
  assert.deepEqual(await ctx.storage.get(`${ACHIEVEMENTS_KNOWN_KEY_PREFIX}42`), ["ACH_B"]);
  assert.equal(ctx.gameFs.files.has(`42:${PORTABLE_SAVE_CONFIG_FILE}`), false);
});

test("achievement sync skips ids already reported and never blocks teardown", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  await ctx.storage.set(`${ACHIEVEMENTS_KNOWN_KEY_PREFIX}42`, ["ACH_B"]);
  writeDefinitions(ctx);

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);
  writeGameFile(
    ctx,
    "gse_saves/480/achievements.json",
    JSON.stringify({ ACH_B: { earned: true } }),
  );

  await hook(ctx, "post-exit:restore").execute(LAUNCH);

  assert.equal(unlockCalls(ctx).length, 0);
  assert.equal(await ctx.storage.get(ACTIVE_ROOM_KEY), null);
});

test("achievement sync stays quiet without portable save state", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  writeDefinitions(ctx);

  await hook(ctx, "post-exit:restore").execute(LAUNCH);

  assert.equal(unlockCalls(ctx).length, 0);
});

test("stage preserves a pre-existing configs.user.ini and honours its save path", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  await new DropGseClientPlugin().init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  writeDefinitions(ctx);

  const existing = "[user::saves]\nlocal_save_path=my_saves\n";
  writeGameFile(ctx, PORTABLE_SAVE_CONFIG_FILE, existing);

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);

  assert.equal(
    new TextDecoder().decode(ctx.gameFs.files.get(`42:${PORTABLE_SAVE_CONFIG_FILE}`)),
    existing,
  );

  writeGameFile(ctx, "my_saves/480/achievements.json", JSON.stringify({ ACH_A: { earned: true } }));

  await hook(ctx, "post-exit:restore").execute(LAUNCH);

  assert.deepEqual(
    unlockCalls(ctx).map((call) => call.body),
    [{ gameId: "42", key: "ACH_A" }],
  );
  assert.equal(
    new TextDecoder().decode(ctx.gameFs.files.get(`42:${PORTABLE_SAVE_CONFIG_FILE}`)),
    existing,
  );
});

test("heartbeat timer starts on stage and stops cleanly on teardown", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  const plugin = new DropGseClientPlugin();
  await plugin.init(ctx);

  // teardown before any stage — no timer was started so it must be a no-op
  plugin.teardown();

  // Set up active room and stage (which starts the heartbeat timer)
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());
  ctx.serverRequestLog.setResponse("POST", "/rooms/r1/heartbeat", { ok: true });
  await hook(ctx, "pre-launch:stage").execute(LAUNCH);

  // teardown should stop the timer without throwing
  plugin.teardown();

  // A second teardown must also be safe
  plugin.teardown();
});

test("stage uses sidecar.patch when sidecar is available", async () => {
  const ctx = new MockClientPluginContext("drop-gse", [
    "ui:slot",
    "ui:play-action",
    "game:launch-hook",
    "game:fs",
    "game:scan",
    "client:storage",
    "client:ws",
    "system:sidecar",
    "system:command",
  ]);
  const plugin = new DropGseClientPlugin();

  // Register version response BEFORE init() — crash recovery during init also
  // probes isAvailable(), and the result is TTL-cached. If we register after
  // init the cache holds 'false' and stage() takes the fallback branch.
  ctx.systemCommand.setResponse("gse-engine", ["version"], {
    code: 0,
    stdout: JSON.stringify({ engine: "gse-engine", version: EXPECTED_SIDECAR_VERSION }),
    stderr: "",
  });
  ctx.systemCommand.setResponse(
    "gse-engine",
    ["patch", "--game-dir", "/games/42", "--app-id", "480", "--peers", "10.242.1.20,10.242.1.21"],
    {
      code: 0,
      stdout: JSON.stringify({ patched: ["steam_api64.dll"], backedUp: ["steam_api64.dll"] }),
      stderr: "",
    },
  );

  await plugin.init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  await hook(ctx, "pre-launch:stage").execute(LAUNCH);

  // Sidecar branch writes root & legacy files but NOT the steam_settings/ tree
  // (the engine owns those when it patches directly)
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_APPID_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_INI}`));
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_MAIN_INI}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_BROADCASTS_FILE}`), false);

  // Verify settings.ini contents are sanitized
  const ini = new TextDecoder().decode(ctx.gameFs.files.get(`42:${STEAM_SETTINGS_INI}`)!);
  assert.match(ini, /room_id=r1/);
  assert.match(ini, /version_id=v1/);
});

test("sanitizeConfigValue strips control characters and '=' that could inject INI entries", () => {
  assert.equal(sanitizeConfigValue("10.242.1.20"), "10.242.1.20");
  assert.equal(sanitizeConfigValue("bad\nvalue"), "badvalue");
  assert.equal(sanitizeConfigValue("key=injection"), "keyinjection");
  assert.equal(sanitizeConfigValue("line\r\nbreak"), "linebreak");
  assert.equal(sanitizeConfigValue("tab\there"), "tabhere");
});

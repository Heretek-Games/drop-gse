import test from "node:test";
import assert from "node:assert/strict";
import { MockClientPluginContext, type LaunchHook } from "@droposs/plugin-sdk";
import {
  ACTIVE_ROOM_KEY,
  CUSTOM_BROADCASTS_FILE,
  DropGseClientPlugin,
  STEAM_APPID_FILE,
  STEAM_SETTINGS_INI,
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
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.id, "gse-join-r1");
  assert.match(actions[0]!.name, /Join GSE room/);

  await actions[0]!.execute(LAUNCH);

  const calls = ctx.serverRequestLog.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(calls, ["GET /rooms?gameId=42", "POST /rooms/r1/join"]);

  const stored = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  assert.equal(stored?.roomId, "r1");
  assert.deepEqual(stored?.peers, ["10.242.1.20", "10.242.1.21"]);
});

test("anti-cheat detection aborts the launch pipeline", async () => {
  const ctx = new MockClientPluginContext("drop-gse");
  const plugin = new DropGseClientPlugin();
  await plugin.init(ctx);
  await ctx.storage.set(ACTIVE_ROOM_KEY, activeRoom());

  ctx.gameScanner.mockAntiCheat = {
    detected: true,
    binaries: ["EasyAntiCheat/EasyAntiCheat.exe"],
  };

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

  assert.ok(ctx.gameFs.backups.has("42:steam_api64.dll"));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_APPID_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`));
  assert.ok(ctx.gameFs.files.has(`42:${STEAM_SETTINGS_INI}`));

  const broadcasts = new TextDecoder().decode(
    ctx.gameFs.files.get(`42:${CUSTOM_BROADCASTS_FILE}`)!,
  );
  assert.equal(broadcasts.trim(), "10.242.1.20\n10.242.1.21");
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
  assert.equal(ctx.gameFs.files.has(`42:${STEAM_APPID_FILE}`), false);
  assert.equal(ctx.gameFs.files.has(`42:${CUSTOM_BROADCASTS_FILE}`), false);
  assert.equal(await ctx.storage.get(ACTIVE_ROOM_KEY), null);
});

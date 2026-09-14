import { test } from "node:test";
import assert from "node:assert/strict";
import { MockClientPluginContext } from "@droposs/plugin-sdk";
import {
  ACTIVE_ROOM_KEY,
  PORTABLE_SAVE_CONFIG_FILE,
  PORTABLE_SAVE_STAGED_KEY,
  STEAM_APPID_FILE,
  STEAM_SETTINGS_INI,
  recoverInterruptedSession,
  type ActiveRoom,
} from "../src/index.js";

const room: ActiveRoom = {
  roomId: "room-1",
  gameId: "game-1",
  versionId: "version-1",
  peers: ["10.0.0.2"],
  expiresAt: Date.now() + 60_000,
};

function makeCtx() {
  return new MockClientPluginContext("drop-gse", ["game:fs", "client:storage"]);
}

test("recovers an interrupted session by restoring backups and clearing staged files", async () => {
  const ctx = makeCtx();
  await ctx.storage.set(ACTIVE_ROOM_KEY, room);
  await ctx.storage.set(PORTABLE_SAVE_STAGED_KEY, true);

  // Original binary, backed up, then replaced by the emulator payload.
  await ctx.gameFs.writeFile("game-1", "steam_api64.dll", "original");
  await ctx.gameFs.backupFile("game-1", "steam_api64.dll");
  await ctx.gameFs.writeFile("game-1", "steam_api64.dll", "emulator");
  await ctx.gameFs.writeFile("game-1", STEAM_APPID_FILE, "123");
  await ctx.gameFs.writeFile("game-1", STEAM_SETTINGS_INI, "[Settings]");
  await ctx.gameFs.writeFile("game-1", PORTABLE_SAVE_CONFIG_FILE, "[user::saves]");

  const result = await recoverInterruptedSession(ctx);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.restored, ["steam_api64.dll"]);
  assert.equal(result.removedStagedConfig, true);

  const restored = new TextDecoder().decode(
    await ctx.gameFs.readFile("game-1", "steam_api64.dll"),
  );
  assert.equal(restored, "original");
  assert.equal(await ctx.gameFs.fileExists("game-1", STEAM_APPID_FILE), false);
  assert.equal(await ctx.gameFs.fileExists("game-1", STEAM_SETTINGS_INI), false);
  assert.equal(
    await ctx.gameFs.fileExists("game-1", PORTABLE_SAVE_CONFIG_FILE),
    false,
  );
  assert.equal(await ctx.storage.get(ACTIVE_ROOM_KEY), null);
  assert.equal(await ctx.storage.get(PORTABLE_SAVE_STAGED_KEY), null);

  // A second sweep is a no-op.
  const again = await recoverInterruptedSession(ctx);
  assert.deepEqual(again, {
    recovered: false,
    restored: [],
    removedStagedConfig: false,
  });
});

test("does nothing when no session was recorded", async () => {
  const ctx = makeCtx();
  const result = await recoverInterruptedSession(ctx);
  assert.equal(result.recovered, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { MockPluginContext, MockPluginStorage } from "@droposs/plugin-sdk";
import {
  CompatRegistry,
  compatFromEnv,
  DEFAULT_BLOCKED_APP_IDS,
  DEFAULT_BLOCKED_GAME_IDS,
} from "../src/compat.js";
import { DropGseServerPlugin } from "../src/index.js";
import { StorageRoomPersistence } from "../src/persistence.js";
import { RoomStore } from "../src/room-store.js";
import type { MeshEventSink } from "../src/room-store.js";
import {
  parseRoom,
  toDiscoverable,
  toMemberView,
  tryParseRoom,
  type EmulatorBinding,
  type PublicMeshInfo,
} from "../src/types.js";

const EMULATOR: EmulatorBinding = {
  flavor: "gbe_fork",
  release: "r1",
  releaseDigest: "sha256-x",
};

const MESH: PublicMeshInfo = {
  backend: "zerotier",
  cidr: "10.242.1.0/24",
  networkId: "8056c2e21c000001",
  expiresAt: 9_999_999,
};

class FakeSink implements MeshEventSink {
  public joins: Array<{ key: string; userId: string }> = [];
  public leaves: Array<{ key: string; userId: string }> = [];
  public closes: string[] = [];

  memberJoin(key: string, userId: string): void {
    this.joins.push({ key, userId });
  }

  memberLeave(key: string, userId: string): void {
    this.leaves.push({ key, userId });
  }

  networkClose(key: string): void {
    this.closes.push(key);
  }
}

function setup(blocked: { appIds?: number[]; gameIds?: string[] } = {}) {
  const sink = new FakeSink();
  const persistence = new StorageRoomPersistence(new MockPluginStorage());
  let now = 1_000_000;
  const store = new RoomStore(
    persistence,
    sink,
    () => now,
    new CompatRegistry({
      blockedAppIds: blocked.appIds ?? [],
      blockedGameIds: blocked.gameIds ?? [],
    }),
  );
  return {
    sink,
    persistence,
    store,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}

async function createRoom(store: RoomStore, host = "host") {
  return store.create({
    gameId: "game-1",
    versionId: "v1",
    appId: 42,
    emulator: EMULATOR,
    hostUserId: host,
  });
}

test("create announces the host to the mesh provider without provisioning", async () => {
  const { store, sink } = setup();
  const room = await createRoom(store);
  assert.equal(room.mesh, undefined);
  assert.deepEqual(sink.joins, [{ key: room.id, userId: "host" }]);
  assert.equal(room.members.length, 1);
});

test("create validates identifiers, appId and emulator binding", async () => {
  const { store } = setup();
  await assert.rejects(
    store.create({
      gameId: "",
      versionId: "v1",
      emulator: EMULATOR,
      hostUserId: "u",
    }),
    /invalid gameId/,
  );
  await assert.rejects(
    store.create({
      gameId: "g",
      versionId: "v1",
      appId: -1,
      emulator: EMULATOR,
      hostUserId: "u",
    }),
    /invalid appId/,
  );
  await assert.rejects(
    store.create({
      gameId: "g",
      versionId: "v1",
      emulator: { ...EMULATOR, flavor: "bogus" as never },
      hostUserId: "u",
    }),
    /invalid emulator flavor/,
  );
});

test("create enforces the per-host room cap", async () => {
  const { store } = setup();
  for (let i = 0; i < 5; i++) {
    await store.create({
      gameId: `game-${i}`,
      versionId: "v1",
      emulator: EMULATOR,
      hostUserId: "host",
    });
  }
  await assert.rejects(createRoom(store), /room limit reached/);
});

test("create rejects known-incompatible games", async () => {
  const { store } = setup({ gameIds: ["bad-game"] });
  await assert.rejects(
    store.create({
      gameId: "bad-game",
      versionId: "v1",
      emulator: EMULATOR,
      hostUserId: "u",
    }),
    /known-incompatible/,
  );
});

test("join announces a new member once and is idempotent", async () => {
  const { store, sink } = setup();
  const room = await createRoom(store);
  await store.join(room.id, "guest");
  await store.join(room.id, "guest");
  assert.deepEqual(
    sink.joins.map((entry) => entry.userId),
    ["host", "guest"],
  );
  const fetched = await store.get(room.id);
  assert.equal(fetched?.members.length, 2);
});

test("leave non-host announces memberLeave; host close tears the network down", async () => {
  const { store, sink } = setup();
  const room = await createRoom(store);
  await store.join(room.id, "guest");

  const guestLeave = await store.leave(room.id, "guest");
  assert.equal(guestLeave.closed, false);
  assert.deepEqual(sink.leaves, [{ key: room.id, userId: "guest" }]);

  const hostLeave = await store.leave(room.id, "host");
  assert.equal(hostLeave.closed, true);
  assert.deepEqual(sink.closes, [room.id]);
  assert.equal(await store.get(room.id), undefined);
});

test("heartbeat by a non-member is rejected with not a room member", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  await assert.rejects(store.heartbeat(room.id, "stranger"), /not a room member/);
  // The room must be unmodified — host is still the host
  const fetched = await store.get(room.id);
  assert.equal(fetched?.hostUserId, "host");
  assert.equal(fetched?.members.length, 1);
});

test("leave by a non-member is a silent no-op with no state mutation or events", async () => {
  const { store, sink } = setup();
  const room = await createRoom(store);
  await store.join(room.id, "guest");
  const leavesBefore = sink.leaves.length;

  const result = await store.leave(room.id, "stranger");
  assert.equal(result.closed, false);
  assert.equal(result.room, undefined);
  assert.equal(sink.leaves.length, leavesBefore); // no memberLeave event emitted

  const fetched = await store.get(room.id);
  assert.equal(fetched?.members.length, 2); // host + guest unchanged
});

test("pruneExpired closes expired rooms", async () => {
  const { store, sink, setNow } = setup();
  const room = await createRoom(store);
  setNow(room.expiresAt + 1);
  const pruned = await store.pruneExpired();
  assert.equal(pruned, 1);
  assert.deepEqual(sink.closes, [room.id]);
});

test("setRoomMesh persists provider info and is redacted for discovery", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  await store.setRoomMesh(room.id, MESH);

  const full = await store.get(room.id);
  assert.deepEqual(full?.mesh, MESH);

  const listed = await store.list("game-1");
  assert.equal(listed[0]?.mesh?.backend, "zerotier");
  if (listed[0]?.mesh?.backend === "zerotier") {
    assert.equal(listed[0].mesh.networkId, "");
  }
});

test("setMemberMesh records the provider-assigned address", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  await store.join(room.id, "guest");
  const updated = await store.setMemberMesh(room.id, "guest", "10.242.1.20");
  const guest = updated?.members.find((m) => m.userId === "guest");
  assert.equal(guest?.meshAddress, "10.242.1.20");
});

test("toMemberView hides peer node ids from non-hosts", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  await store.setMemberMesh(room.id, "host", "10.242.1.20", "abcdef0123");
  const current = (await store.get(room.id))!;
  const hostView = toMemberView(current, true);
  const guestView = toMemberView(current, false);
  assert.equal(hostView.members[0]?.meshNodeId, "abcdef0123");
  assert.equal(guestView.members[0]?.meshNodeId, undefined);
});

test("credential exposes the member address but never a secret", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  await store.setMemberMesh(room.id, "host", "10.242.1.20");
  const credential = await store.credential(room.id, "host");
  assert.equal(credential.secret, "");
  assert.equal(credential.address, "10.242.1.20");
  await assert.rejects(store.credential(room.id, "stranger"), /not a room member/);
});

test("persistence accepts missing and present mesh info", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  const withoutMesh = parseRoom(JSON.parse(JSON.stringify(room)));
  assert.equal(withoutMesh.mesh, undefined);

  await store.setRoomMesh(room.id, MESH);
  const withMesh = parseRoom(JSON.parse(JSON.stringify((await store.get(room.id))!)));
  assert.equal(withMesh.mesh?.backend, "zerotier");

  assert.equal(tryParseRoom({ ...room, mesh: { backend: "bogus", expiresAt: 1 } }), undefined);
});

test("plugin registers delegation routes and no longer owns mesh or members", async () => {
  const { persistence } = setup();
  const plugin = new DropGseServerPlugin(persistence, new FakeSink());
  const ctx = new MockPluginContext("drop-gse");
  plugin.init(ctx);

  assert.ok(ctx.routes.has("GET /rooms"));
  assert.ok(ctx.routes.has("POST /rooms/:id/join"));
  assert.ok(ctx.routes.has("POST /rooms/:id/credential"));
  assert.ok(!ctx.routes.has("GET /backend"));
  assert.ok(!ctx.routes.has("POST /rooms/:id/member"));
  plugin.teardown();
});

test("plugin applies mesh:network and mesh:member provider updates", async () => {
  const sink = new FakeSink();
  const persistence = new StorageRoomPersistence(new MockPluginStorage());
  const seed = new RoomStore(persistence, sink, Date.now);
  const room = await seed.create({
    gameId: "game-1",
    versionId: "v1",
    emulator: EMULATOR,
    hostUserId: "host",
  });

  const plugin = new DropGseServerPlugin(persistence, sink);
  const ctx = new MockPluginContext("drop-gse");
  plugin.init(ctx);

  ctx.broadcast("mesh:network", { key: room.id, mesh: MESH });
  ctx.broadcast("mesh:member", {
    key: room.id,
    userId: "host",
    address: "10.242.1.20",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const getRoute = ctx.routes.get("GET /rooms/:id");
  const result = (await getRoute!.handler(
    {},
    { params: { id: room.id }, query: {}, userId: "host" },
  )) as { room: { mesh?: PublicMeshInfo; members: Array<{ meshAddress?: string }> } };

  assert.equal(result.room.mesh?.backend, "zerotier");
  assert.equal(result.room.members[0]?.meshAddress, "10.242.1.20");
  plugin.teardown();
});

test("toDiscoverable omits mesh until the provider reports it", async () => {
  const { store } = setup();
  const room = await createRoom(store);
  assert.equal(toDiscoverable(room).mesh, undefined);
});

test("compatFromEnv provides default anti-cheat entries and merges env overrides", () => {
  const defaults = compatFromEnv({});
  assert.deepEqual(
    defaults.blockedAppIds,
    [...DEFAULT_BLOCKED_APP_IDS].sort((a, b) => a - b),
  );
  assert.deepEqual(defaults.blockedGameIds, [...DEFAULT_BLOCKED_GAME_IDS].sort());

  const merged = compatFromEnv({
    GSE_BLOCKED_APP_IDS: "999, 1000, 730",
    GSE_BLOCKED_GAME_IDS: "custom-anticheat, valorant",
  });
  assert.ok(merged.blockedAppIds.includes(999));
  assert.ok(merged.blockedAppIds.includes(1000));
  assert.ok(merged.blockedAppIds.includes(730));
  assert.ok(merged.blockedGameIds.includes("custom-anticheat"));
  assert.ok(merged.blockedGameIds.includes("valorant"));
});

test("plugin exposes /compat route containing compatibility registry", async () => {
  const { persistence } = setup();
  const plugin = new DropGseServerPlugin(persistence, new FakeSink());
  const ctx = new MockPluginContext("drop-gse");
  plugin.init(ctx);

  const compatRoute = ctx.routes.get("GET /compat");
  assert.ok(compatRoute);
  const info = (await compatRoute!.handler({}, { params: {}, query: {} })) as {
    blockedAppIds: number[];
    blockedGameIds: string[];
  };
  assert.ok(info.blockedAppIds.includes(730));
  assert.ok(info.blockedGameIds.includes("valorant"));
  plugin.teardown();
});

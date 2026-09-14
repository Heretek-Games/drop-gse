import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMeshBackend,
  TailscaleApiProvisioner,
  TailscaleBackend,
  ZeroTierBackend,
  allocateMemberAddress,
  roomCidr,
} from "../src/mesh.js";
import { CompatRegistry, compatFromEnv } from "../src/compat.js";
import { StorageRoomPersistence } from "../src/persistence.js";
import type { RoomPersistence } from "../src/persistence.js";
import { ZtnetBackend } from "../src/ztnet.js";
import {
  CREDENTIAL_ROTATION_WINDOW_MS,
  HOST_LEASE_MS,
  MAX_ROOMS_PER_HOST,
  ROOM_TTL_MS,
  RoomStore,
} from "../src/room-store.js";
import type { PluginStorage } from "@droposs/plugin-sdk";
import { parseCredential, parseRoom, toMemberView } from "../src/types.js";
import type { EmulatorBinding, MeshBackend } from "../src/types.js";

class MemoryStorage implements PluginStorage {
  private readonly data = new Map<string, unknown>();
  private schemaVersion = 0;
  async get<T>(key: string): Promise<T | null> {
    return this.data.has(key) ? (this.data.get(key) as T) : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async listKeys(): Promise<string[]> {
    return [...this.data.keys()];
  }
  async getSchemaVersion(): Promise<number> {
    return this.schemaVersion;
  }
  async setSchemaVersion(version: number): Promise<void> {
    this.schemaVersion = version;
  }
}

const EMULATOR: EmulatorBinding = {
  flavor: "gbe_fork",
  release: "latest",
  releaseDigest: "sha256-default",
};

interface Harness {
  store: RoomStore;
  backend: InMemoryMeshBackend;
  setNow: (value: number) => void;
}

function harness(): Harness {
  let now = 1_000_000;
  const backend = new InMemoryMeshBackend();
  const store = new RoomStore(new StorageRoomPersistence(new MemoryStorage()), backend, () => now);
  return { store, backend, setNow: (value: number) => (now = value) };
}

function createInput(hostUserId: string) {
  return { gameId: "game-1", versionId: "v1", emulator: EMULATOR, hostUserId };
}

test("RoomStore create/list/join/leave and host close", async () => {
  const { store } = harness();

  const room = await store.create(createInput("host"));
  assert.equal(room.members.length, 1);
  assert.equal(room.mesh.backend, "zerotier");
  assert.equal((await store.list("game-1")).length, 1);

  const joined = await store.join(room.id, "guest");
  assert.equal(joined.members.length, 2);

  const left = await store.leave(room.id, "guest");
  assert.equal(left.closed, false);
  assert.equal((await store.get(room.id))?.members.length, 1);

  const closed = await store.leave(room.id, "host");
  assert.equal(closed.closed, true);
  assert.equal(await store.get(room.id), undefined);
  assert.equal((await store.list()).length, 0);
});

test("RoomStore migrates an expired host lease on join", async () => {
  const h = harness();
  const room = await h.store.create(createInput("host"));

  // Guest joins after the host lease has expired.
  h.setNow(1_000_000 + HOST_LEASE_MS + 1);
  const updated = await h.store.join(room.id, "guest");
  assert.equal(updated.hostUserId, "guest");

  // Original host renewing a heartbeat does not steal it back immediately.
  const beat = await h.store.heartbeat(room.id, "host");
  assert.equal(beat.hostUserId, "guest");
});

test("RoomStore credentials are membership-gated and cached", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));

  await assert.rejects(() => store.credential(room.id, "stranger"), /room member/);

  const first = await store.credential(room.id, "host");
  const second = await store.credential(room.id, "host");
  assert.equal(first.secret, second.secret);
  assert.ok(first.secret.length > 0);
  assert.ok(first.address);

  // The assigned address is reflected in the room member view.
  const refreshed = await store.get(room.id);
  assert.equal(
    refreshed?.members.find((member) => member.userId === "host")?.meshAddress,
    first.address,
  );
});

test("TailscaleBackend provisions a tag and issues one-off keys", async () => {
  const events: string[] = [];
  const backend = new TailscaleBackend({
    provisionRoom: async (roomId) => {
      events.push(`provision:${roomId}`);
      return `tag:dropgse-room-${roomId}`;
    },
    issueAuthKey: async (tag, userId) => {
      events.push(`key:${tag}:${userId}`);
      return `tskey-${userId}`;
    },
    teardownRoom: async (roomId) => {
      events.push(`teardown:${roomId}`);
    },
  });

  const mesh = await backend.provision("r1", 10);
  assert.equal(mesh.backend, "tailscale");
  const issued = await backend.issueCredential("r1", "u1", mesh);
  assert.equal(issued.secret, "tskey-u1");
  await backend.teardown("r1");
  assert.deepEqual(events, ["provision:r1", "key:tag:dropgse-room-r1:u1", "teardown:r1"]);
});

test("RoomStore prunes expired rooms and tears down their mesh", async () => {
  const h = harness();
  const room = await h.store.create(createInput("host"));
  assert.equal(h.backend.memberCount(room.id), 0);

  h.setNow(1_000_000 + ROOM_TTL_MS + 1);
  const pruned = await h.store.pruneExpired();
  assert.equal(pruned, 1);
  assert.equal((await h.store.list()).length, 0);
});

test("RoomStore caps rooms per host", async () => {
  const { store } = harness();
  for (let i = 0; i < MAX_ROOMS_PER_HOST; i++) {
    await store.create(createInput("host"));
  }
  await assert.rejects(() => store.create(createInput("host")), /host/);
});

test("roomCidr is stable and within the base /16", () => {
  const cidr = roomCidr("room-abc");
  assert.match(cidr, /^10\.242\.\d{1,3}\.0\/24$/);
  assert.equal(cidr, roomCidr("room-abc"));
});

test("allocateMemberAddress probes past collisions and exhausts cleanly", () => {
  const cidr = "10.242.7.0/24";
  const first = allocateMemberAddress(cidr, "user-a");
  assert.ok(first);
  // A second member whose hash collides must get a different address.
  const second = allocateMemberAddress(cidr, "user-a", [first]);
  assert.ok(second);
  assert.notEqual(second, first);

  // The pool holds 200 deterministic, unique addresses before it is full.
  const used: string[] = [];
  for (let i = 0; i < 200; i++) {
    const address = allocateMemberAddress(cidr, `member-${i}`, used);
    assert.ok(address);
    used.push(address);
  }
  assert.equal(new Set(used).size, 200);
  assert.equal(allocateMemberAddress(cidr, "overflow", used), undefined);
});

test("ZeroTierBackend provisions a network via the controller API", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "secret-token",
    controllerNodeId: "node123",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "net-xyz" }),
        text: async () => "",
      };
    },
  });

  const mesh = await backend.provision("room-1", 42);
  assert.equal(mesh.backend, "zerotier");
  if (mesh.backend === "zerotier") {
    assert.equal(mesh.networkId, "net-xyz");
    assert.equal(mesh.cidr, roomCidr("room-1"));
  }
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.match(call.url, /\/controller\/network\/node123______$/);
  assert.equal((call.body as { enableBroadcast: boolean }).enableBroadcast, true);
});

test("ZeroTierBackend surfaces controller failures", async () => {
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "t",
    controllerNodeId: "n",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }),
  });
  await assert.rejects(() => backend.provision("room-1", 1), /500/);
});

test("ZeroTierBackend authorizes members and deletes networks", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "t",
    controllerNodeId: "n",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("/controller/network/") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "net-1" }),
          text: async () => "",
        };
      }
      if (url.includes("/network/net-1/member/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ assignedAddresses: ["10.242.5.20/24"] }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  await backend.provision("room-9", 1);
  const address = await backend.authorizeMember("room-9", "user-1", "member-abc");
  assert.equal(address, "10.242.5.20");

  await backend.teardown("room-9");
  const teardownCall = calls.find((call) => call.method === "DELETE");
  assert.ok(teardownCall);
  assert.match(teardownCall.url, /\/controller\/network\/net-1$/);
});

test("ZtnetBackend provisions, authorizes and tears down via the org API", async () => {
  const calls: Array<{
    url: string;
    method?: string;
    body?: string;
    auth?: string;
  }> = [];
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000/",
    apiToken: "org-token",
    organizationId: "org-1",
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body,
        auth: init?.headers?.["x-ztnet-auth"],
      });
      if (url.endsWith("/network") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ nwid: "8056c2e21c000001" }),
          text: async () => "",
        };
      }
      if (url.includes("/member/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ipAssignments: ["10.242.196.20"] }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: init?.method === "DELETE" ? 204 : 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  const mesh = await backend.provision("room-zt", 1_700_000_000_000);
  assert.equal(mesh.backend, "zerotier");
  if (mesh.backend === "zerotier") {
    assert.equal(mesh.networkId, "8056c2e21c000001");
    assert.equal(mesh.cidr, roomCidr("room-zt"));
  }

  const posts = calls.filter((call) => call.method === "POST");
  assert.ok(posts.length >= 2);
  assert.equal(posts[0]?.auth, "org-token");
  const configureBody = JSON.parse(
    posts.find((call) => call.url.endsWith("8056c2e21c000001"))?.body ?? "{}",
  ) as {
    v4AssignMode: { zt: boolean };
    routes: Array<{ target: string }>;
  };
  assert.equal(configureBody.v4AssignMode.zt, true);
  assert.equal(configureBody.routes[0]?.target, roomCidr("room-zt"));

  const address = await backend.authorizeMember("room-zt", "user-1", "abcdef01234");
  assert.equal(address, "10.242.196.20");

  await backend.revokeMember("room-zt", "user-1");
  await backend.teardown("room-zt", mesh);
  assert.ok(
    calls.some(
      (call) => call.method === "DELETE" && call.url.endsWith("/network/8056c2e21c000001"),
    ),
  );
});

test("ZtnetBackend surfaces API errors", async () => {
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "t",
    organizationId: "org-1",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "unauthorized",
    }),
  });
  await assert.rejects(() => backend.provision("r", 1), /401/);
});

test("ZtnetBackend teardown works from a persisted mesh after restart", async () => {
  const deletes: string[] = [];
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "t",
    organizationId: "org-1",
    fetchImpl: async (url, init) => {
      if (init?.method === "DELETE") deletes.push(url);
      return {
        ok: true,
        status: 204,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  await backend.teardown("room-x", {
    backend: "zerotier",
    cidr: "10.242.1.0/24",
    networkId: "nw-persisted",
    expiresAt: 1,
  });
  assert.deepEqual(deletes, ["http://ztnet:3000/api/v1/org/org-1/network/nw-persisted"]);
});

test("ZtnetBackend authorizes and revokes from persisted mesh after restart", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  // No prior provision(): simulates a coordinator that restarted with an empty
  // in-memory state but persisted room.mesh.
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "t",
    organizationId: "org-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method });
      return {
        ok: true,
        status: init?.method === "DELETE" ? 204 : 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });
  const persisted = {
    backend: "zerotier" as const,
    cidr: "10.242.1.0/24",
    networkId: "nw-persisted",
    expiresAt: 1,
  };

  const address = await backend.authorizeMember("room-x", "user-1", "abcdef0123", persisted);
  assert.ok(address, "address should be assigned from the persisted pool");
  assert.ok(
    calls.some(
      (call) =>
        call.url.endsWith("/network/nw-persisted/member/abcdef0123") && call.method === "POST",
    ),
  );

  await backend.revokeMember("room-x", "user-1", persisted, "abcdef0123");
  assert.ok(
    calls.some(
      (call) =>
        call.method === "DELETE" && call.url.endsWith("/network/nw-persisted/member/abcdef0123"),
    ),
  );
});

test("ZtnetBackend surfaces revocation failures", async () => {
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "t",
    organizationId: "org-1",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }),
  });
  await assert.rejects(
    () =>
      backend.revokeMember(
        "room-x",
        "user-1",
        {
          backend: "zerotier",
          cidr: "10.242.1.0/24",
          networkId: "nw-1",
          expiresAt: 1,
        },
        "abcdef0123",
      ),
    /500/,
  );
});

test("RoomStore revokes using persisted node id after a restart", async () => {
  const storage = new MemoryStorage();
  const room = await new RoomStore(
    new StorageRoomPersistence(storage),
    new InMemoryMeshBackend(),
    () => 1_000_000,
  ).create(createInput("host"));

  // A later store instance (fresh process) registers the guest's node id.
  const store1 = new RoomStore(
    new StorageRoomPersistence(storage),
    new InMemoryMeshBackend(),
    () => 1_000_000,
  );
  await store1.join(room.id, "guest");
  await store1.registerMember(room.id, "guest", "abcdef0123");

  // Restart again with a brand-new backend whose in-memory maps are empty.
  const deletes: string[] = [];
  const restarted = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "t",
    organizationId: "org-1",
    fetchImpl: async (url, init) => {
      if (init?.method === "DELETE") deletes.push(url);
      return {
        ok: true,
        status: init?.method === "DELETE" ? 204 : 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });
  const store2 = new RoomStore(new StorageRoomPersistence(storage), restarted, () => 1_000_000);

  const left = await store2.leave(room.id, "guest");
  assert.equal(left.closed, false);
  assert.ok(
    deletes.some((url) => url.endsWith("/member/abcdef0123")),
    "the restarted backend should revoke the persisted node id",
  );
});

test("TailscaleApiProvisioner issues one-off keys and revokes them", async () => {
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "ts-key",
    tailnet: "example.com",
    tag: "tag:dropgse",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "key-1", key: "tskey-ephemeral" }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      };
    },
  });

  const backend = new TailscaleBackend(provisioner);
  const mesh = await backend.provision("room-1", 1);
  const issued = await backend.issueCredential("room-1", "user-1", mesh);
  assert.equal(issued.secret, "tskey-ephemeral");

  await backend.teardown("room-1");
  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(
    (
      JSON.parse(post.body ?? "{}") as {
        capabilities: { devices: { create: { tags: string[] } } };
      }
    ).capabilities.devices.create.tags[0],
    "tag:dropgse",
  );
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/keys/key-1")));
});

test("TailscaleApiProvisioner surfaces key deletion failures", async () => {
  let issued = false;
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "ts-key",
    tailnet: "example.com",
    tag: "tag:dropgse",
    fetchImpl: async (_url, init) => {
      if (init?.method === "DELETE") {
        return {
          ok: false,
          status: 403,
          json: async () => ({}),
          text: async () => "denied",
        };
      }
      issued = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "key-1", key: "tskey-ephemeral" }),
        text: async () => "",
      };
    },
  });

  await provisioner.issueAuthKey("tag:dropgse", "user-1", "room-1");
  assert.ok(issued);
  await assert.rejects(() => provisioner.teardownRoom("room-1"), /403/);
});

test("RoomStore records the address authorized for a member node", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));
  const updated = await store.registerMember(room.id, "host", "1234567890");
  assert.ok(updated.members.find((m) => m.userId === "host")?.meshAddress);
});

test("RoomStore rejects known-incompatible games and pins AppID", async () => {
  const store = new RoomStore(
    new StorageRoomPersistence(new MemoryStorage()),
    new InMemoryMeshBackend(),
    () => 1_000_000,
    new CompatRegistry({ blockedAppIds: [1234], blockedGameIds: ["bad-game"] }),
  );

  await assert.rejects(
    () =>
      store.create({
        gameId: "game-1",
        versionId: "v1",
        appId: 1234,
        emulator: EMULATOR,
        hostUserId: "host",
      }),
    /incompatible/,
  );
  await assert.rejects(
    () =>
      store.create({
        gameId: "bad-game",
        versionId: "v1",
        emulator: EMULATOR,
        hostUserId: "host",
      }),
    /incompatible/,
  );

  const room = await store.create({
    gameId: "good-game",
    versionId: "v1",
    appId: 999,
    emulator: EMULATOR,
    hostUserId: "host",
  });
  assert.equal(room.appId, 999);
  assert.equal((await store.list())[0]?.appId, 999);
});

test("RoomStore rotates credentials near expiry", async () => {
  const h = harness();
  const room = await h.store.create(createInput("host"));
  const first = await h.store.credential(room.id, "host");

  // Move to within the rotation window of the room's expiry.
  h.setNow(room.expiresAt - CREDENTIAL_ROTATION_WINDOW_MS + 1);
  const second = await h.store.credential(room.id, "host");
  assert.ok(second.issuedAt > first.issuedAt);
});

test("compatFromEnv parses blocked app and game lists", () => {
  const info = compatFromEnv({
    GSE_BLOCKED_APP_IDS: "1, 2, x",
    GSE_BLOCKED_GAME_IDS: "a, b",
  });
  assert.deepEqual(info.blockedAppIds, [1, 2]);
  assert.deepEqual(info.blockedGameIds, ["a", "b"]);
});

test("RoomStore discovery redacts the mesh network id", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));
  const [listed] = await store.list();
  assert.ok(listed);
  assert.equal(listed.mesh.backend, "zerotier");
  if (listed.mesh.backend === "zerotier") {
    assert.equal(listed.mesh.networkId, "");
    assert.equal(listed.mesh.cidr, roomCidr(room.id));
  }

  // Members still see the full mesh on the room itself.
  const full = await store.get(room.id);
  assert.ok(full);
  assert.equal(full.mesh.backend, "zerotier");
  if (full.mesh.backend === "zerotier") {
    assert.ok(full.mesh.networkId.length > 0);
  }
});

test("StorageRoomPersistence redacts secrets and sweeps expired credentials", async () => {
  const storage = new MemoryStorage();
  const persistence = new StorageRoomPersistence(storage);
  const store = new RoomStore(persistence, new InMemoryMeshBackend(), () => 1_000_000);
  const room = await store.create(createInput("host"));

  await persistence.saveCredential(room.id, {
    roomId: room.id,
    userId: "host",
    secret: "super-secret",
    address: "10.242.1.20",
    issuedAt: 1_000_000,
    expiresAt: 2_000_000,
  });
  const stored = await persistence.getCredentials(room.id);
  assert.equal(stored["host"]?.secret, "");
  assert.equal(stored["host"]?.address, "10.242.1.20");

  assert.equal(await persistence.deleteExpiredCredentials(1_500_000), 0);
  assert.equal(await persistence.deleteExpiredCredentials(2_500_000), 1);
  assert.deepEqual(await persistence.getCredentials(room.id), {});
});

test("parseRoom and parseCredential reject corrupt payloads", () => {
  const room = {
    id: "r",
    gameId: "g",
    versionId: "v",
    hostUserId: "h",
    hostHeartbeatAt: 1,
    createdAt: 1,
    expiresAt: 2,
    members: [{ userId: "h", joinedAt: 1 }],
    mesh: {
      backend: "zerotier",
      cidr: "10.242.1.0/24",
      networkId: "n",
      expiresAt: 2,
    },
    emulator: { flavor: "gbe_fork", release: "latest", releaseDigest: "d" },
  };
  assert.equal(parseRoom(room).id, "r");
  assert.throws(() => parseRoom({ ...room, mesh: { backend: "bogus", expiresAt: 2 } }));
  assert.throws(() => parseRoom({ ...room, members: "nope" }));
  assert.throws(() => parseRoom(null));

  const credential = {
    roomId: "r",
    userId: "u",
    secret: "",
    issuedAt: 1,
    expiresAt: 2,
  };
  assert.equal(parseCredential(credential).userId, "u");
  assert.throws(() => parseCredential({ roomId: "r" }));
});

test("RoomStore host close deletes the room and its credentials together", async () => {
  const storage = new MemoryStorage();
  const persistence = new StorageRoomPersistence(storage);
  const store = new RoomStore(persistence, new InMemoryMeshBackend(), () => 1_000_000);
  const room = await store.create(createInput("host"));
  await store.credential(room.id, "host");
  assert.ok(Object.keys(await persistence.getCredentials(room.id)).length > 0);

  const closed = await store.leave(room.id, "host");
  assert.equal(closed.closed, true);
  assert.equal(await persistence.getRoom(room.id), undefined);
  assert.deepEqual(await persistence.getCredentials(room.id), {});
});

test("RoomStore rejects invalid room input and malformed member ids", async () => {
  const { store } = harness();

  await assert.rejects(
    () => store.create({ ...createInput("host"), gameId: "" }),
    /invalid gameId/,
  );
  await assert.rejects(
    () =>
      store.create({
        ...createInput("host"),
        emulator: { flavor: "bogus" } as unknown as EmulatorBinding,
      }),
    /invalid emulator flavor/,
  );
  await assert.rejects(() => store.create({ ...createInput("host"), appId: 1.5 }), /invalid appId/);

  const room = await store.create(createInput("host"));
  await assert.rejects(
    () => store.registerMember(room.id, "host", "../../evil"),
    /invalid mesh member id/,
  );
  await assert.rejects(
    () => store.registerMember(room.id, "host", "not-a-node-id"),
    /invalid mesh member id/,
  );
});

test("RoomStore list skips corrupt persisted rooms", async () => {
  const storage = new MemoryStorage();
  await storage.set("rooms", {
    good: {
      id: "good",
      gameId: "game-1",
      versionId: "v1",
      emulator: EMULATOR,
      hostUserId: "host",
      hostHeartbeatAt: 1_000_000,
      members: [{ userId: "host", joinedAt: 1_000_000 }],
      mesh: {
        backend: "zerotier",
        cidr: "10.242.1.0/24",
        networkId: "network-1",
        expiresAt: 2_000_000,
      },
      createdAt: 1_000_000,
      expiresAt: 2_000_000,
    },
    corrupt: { id: "corrupt", emulator: { flavor: "bogus" } },
  });
  const store = new RoomStore(
    new StorageRoomPersistence(storage),
    new InMemoryMeshBackend(),
    () => 1_000_000,
  );

  const rooms = await store.list();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0]?.id, "good");

  // Room creation must keep working despite the corrupt row.
  const created = await store.create(createInput("host-2"));
  assert.ok(created.id);
});

test("pruneExpired retries teardown instead of orphaning rooms", async () => {
  const storage = new MemoryStorage();
  const persistence = new StorageRoomPersistence(storage);
  const base = new InMemoryMeshBackend();
  let failNext = true;
  const backend: MeshBackend = {
    id: base.id,
    provision: (roomId, expiresAt) => base.provision(roomId, expiresAt),
    issueCredential: (roomId, userId, mesh) => base.issueCredential(roomId, userId, mesh),
    authorizeMember: (roomId, userId, memberId, mesh, used) =>
      base.authorizeMember!(roomId, userId, memberId, mesh, used),
    revokeMember: async () => {},
    teardown: async (roomId, mesh) => {
      if (failNext) {
        failNext = false;
        throw new Error("controller unavailable");
      }
      await base.teardown(roomId, mesh);
    },
  };

  let now = 1_000_000;
  const store = new RoomStore(persistence, backend, () => now);
  const room = await store.create(createInput("host"));

  now += ROOM_TTL_MS + 1;
  assert.equal(await store.pruneExpired(), 0);
  assert.ok(
    await persistence.getRoom(room.id),
    "failed teardown must keep the row for a later retry",
  );

  assert.equal(await store.pruneExpired(), 1);
  assert.equal(await persistence.getRoom(room.id), undefined);
});

test("RoomStore rejects a mesh node id already held by another member", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));
  await store.join(room.id, "guest");
  await store.registerMember(room.id, "host", "abcdef0123");

  await assert.rejects(
    () => store.registerMember(room.id, "guest", "abcdef0123"),
    /already registered/,
  );
});

test("toMemberView hides peer node ids from non-hosts", async () => {
  const { store } = harness();
  const room = await store.create(createInput("host"));
  await store.join(room.id, "guest");
  const updated = await store.registerMember(room.id, "host", "abcdef0123");

  const hostMember = (view: { members: Array<{ userId: string; meshNodeId?: string }> }) =>
    view.members.find((member) => member.userId === "host");

  assert.equal(hostMember(toMemberView(updated, true))?.meshNodeId, "abcdef0123");
  assert.equal(hostMember(toMemberView(updated, false))?.meshNodeId, undefined);
});

test("RoomStore tears down a provisioned mesh when persisting the room fails", async () => {
  const persistence = new StorageRoomPersistence(new MemoryStorage());
  const failing: RoomPersistence = {
    listRooms: () => persistence.listRooms(),
    getRoom: (id) => persistence.getRoom(id),
    saveRoom: async () => {
      throw new Error("database unavailable");
    },
    deleteRoom: (id) => persistence.deleteRoom(id),
    deleteRoomData: (id) => persistence.deleteRoomData(id),
    getCredentials: (id) => persistence.getCredentials(id),
    saveCredential: (id, credential) => persistence.saveCredential(id, credential),
    deleteCredentials: (id) => persistence.deleteCredentials(id),
    deleteExpiredCredentials: (before) => persistence.deleteExpiredCredentials(before),
  };

  const base = new InMemoryMeshBackend();
  const tornDown: string[] = [];
  const backend: MeshBackend = {
    id: base.id,
    provision: (roomId, expiresAt) => base.provision(roomId, expiresAt),
    issueCredential: (r, u, m) => base.issueCredential(r, u, m),
    authorizeMember: (r, u, mid, m, used) => base.authorizeMember!(r, u, mid, m, used),
    revokeMember: async () => {},
    teardown: async (roomId, mesh) => {
      tornDown.push(roomId);
      await base.teardown(roomId, mesh);
    },
  };

  const store = new RoomStore(failing, backend, () => 1_000_000);
  await assert.rejects(() => store.create(createInput("host")), /database unavailable/);
  assert.equal(tornDown.length, 1, "the orphaned mesh must be torn down");
});

test("RoomStore honors a backend-imposed credential expiry", async () => {
  const base = new InMemoryMeshBackend();
  const backend: MeshBackend = {
    id: base.id,
    provision: (roomId, expiresAt) => base.provision(roomId, expiresAt),
    issueCredential: (roomId, userId, mesh) =>
      Promise.resolve({
        secret: baseSecret(roomId, userId, mesh),
        address: "10.242.1.20",
        expiresAt: 1_000_000 + 1_000,
      }),
    authorizeMember: (r, u, mid, m, used) => base.authorizeMember!(r, u, mid, m, used),
    revokeMember: async () => {},
    teardown: async () => {},
  };
  const store = new RoomStore(
    new StorageRoomPersistence(new MemoryStorage()),
    backend,
    () => 1_000_000,
  );
  const room = await store.create(createInput("host"));
  const credential = await store.credential(room.id, "host");
  assert.equal(credential.expiresAt, 1_001_000);
});

function baseSecret(roomId: string, userId: string, mesh: { backend: string }): string {
  return `zt-member:${roomId}:${userId}:${mesh.backend}`;
}

test("ZtnetBackend treats a 404 teardown as success", async () => {
  const backend = new ZtnetBackend({
    baseUrl: "http://ztnet:3000",
    apiToken: "t",
    organizationId: "org-1",
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "not found",
    }),
  });
  await assert.doesNotReject(() =>
    backend.teardown("room-x", {
      backend: "zerotier",
      cidr: "10.242.1.0/24",
      networkId: "nw-gone",
      expiresAt: 1,
    }),
  );
});

test("ZeroTierBackend treats a 404 teardown as success", async () => {
  const backend = new ZeroTierBackend({
    baseUrl: "http://localhost:9993",
    authToken: "t",
    controllerNodeId: "n",
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "not found",
    }),
  });
  await assert.doesNotReject(() =>
    backend.teardown("room-x", {
      backend: "zerotier",
      cidr: "10.242.1.0/24",
      networkId: "net-gone",
      expiresAt: 1,
    }),
  );
});

test("TailscaleApiProvisioner revokes the previous key before re-issuing", async () => {
  const deletes: string[] = [];
  let issued = 0;
  const provisioner = new TailscaleApiProvisioner({
    apiKey: "ts-key",
    tailnet: "example.com",
    tag: "tag:dropgse",
    fetchImpl: async (url, init) => {
      if (init?.method === "DELETE") {
        deletes.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "",
        };
      }
      issued += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: `key-${issued}`, key: `tskey-${issued}` }),
        text: async () => "",
      };
    },
  });

  const first = await provisioner.issueAuthKey("tag:dropgse", "user-1", "room-1");
  const second = await provisioner.issueAuthKey("tag:dropgse", "user-1", "room-1");
  assert.equal(first, "tskey-1");
  assert.equal(second, "tskey-2");
  assert.deepEqual(deletes, ["https://api.tailscale.com/api/v2/tailnet/example.com/keys/key-1"]);
});

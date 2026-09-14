import { randomUUID } from "node:crypto";
import type { CompatRegistry } from "./compat.js";
import type { RoomPersistence } from "./persistence.js";
import type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshBackend,
  MeshCredential,
  Room,
} from "./types.js";
import { isMeshMemberId, toDiscoverable } from "./types.js";

/** Room lifetime. */
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
/** Host renews its lease this often. */
export const HOST_HEARTBEAT_MS = 15_000;
/** Host lease expires after this much silence. */
export const HOST_LEASE_MS = 45_000;
/** Re-issue a credential when this close to expiry. */
export const CREDENTIAL_ROTATION_WINDOW_MS = 10 * 60 * 1000;
/** Per-host concurrent room cap. */
export const MAX_ROOMS_PER_HOST = 5;
/** Global room cap. */
export const MAX_ROOMS = 200;

export interface CreateRoomInput {
  gameId: string;
  versionId: string;
  appId?: number;
  emulator: EmulatorBinding;
  hostUserId: string;
}

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_BINDING_LENGTH = 256;

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function requireEmulatorBinding(value: unknown): EmulatorBinding {
  if (!value || typeof value !== "object") {
    throw new Error("invalid emulator binding");
  }
  const binding = value as Partial<EmulatorBinding>;
  if (binding.flavor !== "gbe_fork" && binding.flavor !== "gse_fork") {
    throw new Error("invalid emulator flavor");
  }
  if (typeof binding.release !== "string" || binding.release.length > MAX_BINDING_LENGTH) {
    throw new Error("invalid emulator release");
  }
  if (
    typeof binding.releaseDigest !== "string" ||
    binding.releaseDigest.length > MAX_BINDING_LENGTH
  ) {
    throw new Error("invalid emulator release digest");
  }
  return binding as EmulatorBinding;
}

/**
 * Room registry with distributed-ish host leases, backed by a
 * {@link RoomPersistence} (Postgres in production, plugin storage in tests).
 *
 * Host migration is first-writer-wins: any member may claim an expired lease
 * on join/heartbeat.
 */
export class RoomStore {
  /**
   * Serializes room mutations within this process so read-modify-write on the
   * JSON payload cannot clobber concurrent updates. (Postgres adds atomic
   * deletes on top; multi-process coordination would need row locks.)
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * In-process cache of live credentials. Persistence redacts secrets at rest,
   * so this is what makes credential reads actually cache instead of issuing a
   * fresh backend key on every request (e.g. one Tailscale key per call).
   */
  private readonly credentialCache = new Map<string, MeshCredential>();

  private cacheKey(roomId: string, userId: string): string {
    return `${roomId}\u0000${userId}`;
  }

  private clearRoomCache(roomId: string): void {
    const prefix = `${roomId}\u0000`;
    for (const key of this.credentialCache.keys()) {
      if (key.startsWith(prefix)) this.credentialCache.delete(key);
    }
  }

  constructor(
    private readonly persistence: RoomPersistence,
    private readonly backend: MeshBackend,
    private readonly now: () => number = Date.now,
    private readonly compat?: CompatRegistry,
  ) {}

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /** Drop expired rooms, tear their mesh down and sweep their credentials. */
  async pruneExpired(): Promise<number> {
    return this.withLock("__prune__", async () => {
      const rooms = await this.persistence.listRooms();
      const expired = rooms.filter((room) => room.expiresAt <= this.now());
      let pruned = 0;
      for (const room of expired) {
        // Take the room's own lock so a prune cannot tear a mesh down
        // concurrently with a join/heartbeat/leave/credential read-modify-write.
        const removed = await this.withLock(room.id, async () => {
          // Re-read: another operation may have renewed the room meanwhile.
          const current = await this.persistence.getRoom(room.id);
          if (!current || current.expiresAt > this.now()) return 0;
          try {
            await this.backend.teardown(room.id, current.mesh);
          } catch {
            // Keep the persisted mesh so a later sweep can retry the teardown
            // instead of orphaning the provisioned network.
            return 0;
          }
          await this.persistence.deleteRoomData(room.id);
          this.clearRoomCache(room.id);
          return 1;
        });
        pruned += removed;
      }
      await this.persistence.deleteExpiredCredentials(this.now());
      return pruned;
    });
  }

  async create(input: CreateRoomInput): Promise<Room> {
    return this.withLock("__create__", async () => {
      const gameId = requireIdentifier(input.gameId, "gameId");
      const versionId = requireIdentifier(input.versionId, "versionId");
      const emulator = requireEmulatorBinding(input.emulator);
      if (
        input.appId !== undefined &&
        (!Number.isInteger(input.appId) || input.appId < 0 || input.appId > 0xffffffff)
      ) {
        throw new Error("invalid appId");
      }

      const rooms = await this.persistence.listRooms();
      const now = this.now();

      const hostRooms = rooms.filter(
        (room) => room.hostUserId === input.hostUserId && room.expiresAt > now,
      );
      if (hostRooms.length >= MAX_ROOMS_PER_HOST) {
        throw new Error("room limit reached for this host");
      }
      if (rooms.length >= MAX_ROOMS) {
        throw new Error("global room limit reached");
      }
      if (this.compat?.isBlocked(gameId, input.appId)) {
        throw new Error("game is known-incompatible with GSE");
      }

      const roomId = randomUUID();
      const expiresAt = now + ROOM_TTL_MS;
      const mesh = await this.backend.provision(roomId, expiresAt);

      const room: Room = {
        id: roomId,
        gameId,
        versionId,
        appId: input.appId,
        emulator,
        hostUserId: input.hostUserId,
        hostHeartbeatAt: now,
        members: [{ userId: input.hostUserId, joinedAt: now }],
        mesh,
        createdAt: now,
        expiresAt,
      };
      try {
        await this.persistence.saveRoom(room);
      } catch (err) {
        // The mesh was already provisioned; roll it back so a persistence
        // failure does not orphan a network that no room row can ever sweep.
        try {
          await this.backend.teardown(roomId, mesh);
        } catch {
          // Best effort; a later sweep cannot see the room, so log-and-drop.
        }
        throw err;
      }
      return room;
    });
  }

  async get(roomId: string): Promise<Room | undefined> {
    const room = await this.persistence.getRoom(roomId);
    if (!room || room.expiresAt <= this.now()) return undefined;
    return room;
  }

  async list(gameId?: string): Promise<DiscoverableRoom[]> {
    const rooms = await this.persistence.listRooms();
    const now = this.now();
    return rooms
      .filter((room) => room.expiresAt > now)
      .filter((room) => !gameId || room.gameId === gameId)
      .map(toDiscoverable);
  }

  private claimExpiredLease(room: Room): void {
    const now = this.now();
    if (now - room.hostHeartbeatAt <= HOST_LEASE_MS) return;
    const candidates = room.members
      .filter((member) => member.userId !== room.hostUserId)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const successor = candidates[0] ?? room.members[0];
    if (successor) {
      room.hostUserId = successor.userId;
      room.hostHeartbeatAt = now;
    }
  }

  async join(roomId: string, userId: string): Promise<Room> {
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room || room.expiresAt <= this.now()) {
        throw new Error("room not found");
      }
      if (!room.members.some((member) => member.userId === userId)) {
        room.members.push({ userId, joinedAt: this.now() });
      }
      this.claimExpiredLease(room);
      await this.persistence.saveRoom(room);
      return room;
    });
  }

  /**
   * Authorize a member's mesh node after it joins and record its address.
   * Called when the client reports its backend member id.
   */
  async registerMember(roomId: string, userId: string, memberId: string): Promise<Room> {
    if (!isMeshMemberId(memberId)) {
      throw new Error("invalid mesh member id");
    }
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room || room.expiresAt <= this.now()) {
        throw new Error("room not found");
      }
      const member = room.members.find((entry) => entry.userId === userId);
      if (!member) {
        throw new Error("not a room member");
      }

      // A node id identifies one device; two members must never share one, or
      // either could revoke/kick the other. Reject a node already held by
      // someone else.
      const heldByAnother = room.members.some(
        (entry) => entry.userId !== userId && entry.meshNodeId === memberId,
      );
      if (heldByAnother) {
        throw new Error("mesh member id already registered to another member");
      }

      // Release the caller's previous node id when it rotates, so a stale node
      // does not remain authorized.
      if (member.meshNodeId && member.meshNodeId !== memberId) {
        await this.backend.revokeMember(roomId, userId, room.mesh, member.meshNodeId);
      }

      // Persist the node id even when authorization cannot assign an address,
      // so revocation still works after a coordinator restart.
      member.meshNodeId = memberId;
      if (this.backend.authorizeMember) {
        const used = room.members
          .filter((entry) => entry.userId !== userId)
          .map((entry) => entry.meshAddress)
          .filter((address): address is string => Boolean(address));
        const address = await this.backend.authorizeMember(
          roomId,
          userId,
          memberId,
          room.mesh,
          used,
        );
        if (address) member.meshAddress = address;
      }
      await this.persistence.saveRoom(room);
      return room;
    });
  }

  async heartbeat(roomId: string, userId: string): Promise<Room> {
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room || room.expiresAt <= this.now()) {
        throw new Error("room not found");
      }
      this.claimExpiredLease(room);
      if (room.hostUserId === userId) {
        room.hostHeartbeatAt = this.now();
      }
      await this.persistence.saveRoom(room);
      return room;
    });
  }

  async leave(roomId: string, userId: string): Promise<{ closed: boolean; room?: Room }> {
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room) return { closed: false };

      if (room.hostUserId === userId) {
        await this.backend.teardown(roomId, room.mesh);
        await this.persistence.deleteRoomData(roomId);
        this.clearRoomCache(roomId);
        return { closed: true };
      }

      const leaving = room.members.find((member) => member.userId === userId);
      room.members = room.members.filter((member) => member.userId !== userId);
      await this.backend.revokeMember(roomId, userId, room.mesh, leaving?.meshNodeId);
      await this.persistence.saveRoom(room);
      this.credentialCache.delete(this.cacheKey(roomId, userId));
      return { closed: false, room };
    });
  }

  /** Issue (or return the existing) server-side credential for a member. */
  async credential(roomId: string, userId: string): Promise<MeshCredential> {
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room || room.expiresAt <= this.now()) {
        throw new Error("room not found");
      }
      const member = room.members.find((entry) => entry.userId === userId);
      if (!member) {
        throw new Error("not a room member");
      }

      const key = this.cacheKey(roomId, userId);
      const cached = this.credentialCache.get(key);
      // Prefer the live in-process credential; persistence redacts the secret,
      // so reading it back always requires a re-issue.
      if (cached && cached.expiresAt - this.now() > CREDENTIAL_ROTATION_WINDOW_MS) {
        return cached;
      }

      const roomCredentials = await this.persistence.getCredentials(roomId);
      const existing = roomCredentials[userId];
      const issued = await this.backend.issueCredential(roomId, userId, room.mesh);
      const credential: MeshCredential = {
        roomId,
        userId,
        secret: issued.secret,
        address: issued.address ?? existing?.address ?? cached?.address,
        issuedAt: this.now(),
        // Respect a backend-imposed lifetime (e.g. a 1h Tailscale key) so the
        // reported expiry does not overstate the credential's validity.
        expiresAt: Math.min(room.expiresAt, issued.expiresAt ?? room.expiresAt),
      };
      this.credentialCache.set(key, credential);

      // Record the assigned mesh address so peers see it in the room view.
      const address = issued.address ?? existing?.address;
      if (address && member.meshAddress !== address) {
        member.meshAddress = address;
        await this.persistence.saveRoom(room);
      }

      await this.persistence.saveCredential(roomId, credential);
      return credential;
    });
  }
}

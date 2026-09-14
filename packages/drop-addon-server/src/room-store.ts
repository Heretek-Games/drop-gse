import { randomUUID } from "node:crypto";
import type { CompatRegistry } from "./compat.js";
import type { RoomPersistence } from "./persistence.js";
import type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshCredential,
  PublicMeshInfo,
  Room,
} from "./types.js";
import { toDiscoverable } from "./types.js";

/** Room lifetime. */
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
/** Host renews its lease this often. */
export const HOST_HEARTBEAT_MS = 15_000;
/** Host lease expires after this much silence. */
export const HOST_LEASE_MS = 45_000;
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

/**
 * Outbound mesh-coordination hooks. drop-gse does not own the mesh; it tells
 * the mesh provider (`drop-zerotier`) which users belong to which room and the
 * provider reports network/member details back over the event bus.
 */
export interface MeshEventSink {
  memberJoin(key: string, userId: string): void;
  memberLeave(key: string, userId: string): void;
  networkClose(key: string): void;
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
 * Mesh membership and addresses are delegated to the mesh provider: the store
 * emits {@link MeshEventSink} events and receives network/member updates back
 * via {@link setRoomMesh} / {@link setMemberMesh}.
 */
export class RoomStore {
  /**
   * Serializes room mutations within this process so read-modify-write on the
   * JSON payload cannot clobber concurrent updates.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly persistence: RoomPersistence,
    private readonly meshEvents: MeshEventSink,
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

  /** Drop expired rooms and tell the provider to tear their networks down. */
  async pruneExpired(): Promise<number> {
    return this.withLock("__prune__", async () => {
      const rooms = await this.persistence.listRooms();
      const expired = rooms.filter((room) => room.expiresAt <= this.now());
      let pruned = 0;
      for (const room of expired) {
        const removed = await this.withLock(room.id, async () => {
          // Re-read: another operation may have renewed the room meanwhile.
          const current = await this.persistence.getRoom(room.id);
          if (!current || current.expiresAt > this.now()) return 0;
          this.meshEvents.networkClose(room.id);
          await this.persistence.deleteRoomData(room.id);
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
      const room: Room = {
        id: roomId,
        gameId,
        versionId,
        appId: input.appId,
        emulator,
        hostUserId: input.hostUserId,
        hostHeartbeatAt: now,
        members: [{ userId: input.hostUserId, joinedAt: now }],
        createdAt: now,
        expiresAt,
      };
      await this.persistence.saveRoom(room);
      this.meshEvents.memberJoin(roomId, input.hostUserId);
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
        this.meshEvents.memberJoin(roomId, userId);
      }
      this.claimExpiredLease(room);
      await this.persistence.saveRoom(room);
      return room;
    });
  }

  /** Record the mesh address the provider assigned to a member. */
  async setMemberMesh(
    roomId: string,
    userId: string,
    address?: string,
    nodeId?: string,
  ): Promise<Room | undefined> {
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room) return undefined;
      const member = room.members.find((entry) => entry.userId === userId);
      if (!member) return room;
      if (nodeId) member.meshNodeId = nodeId;
      if (address) member.meshAddress = address;
      await this.persistence.saveRoom(room);
      return room;
    });
  }

  /** Record the provider's public mesh info for a room. */
  async setRoomMesh(roomId: string, mesh: PublicMeshInfo): Promise<void> {
    return this.withLock(roomId, async () => {
      const room = await this.persistence.getRoom(roomId);
      if (!room) return;
      room.mesh = mesh;
      await this.persistence.saveRoom(room);
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
        this.meshEvents.networkClose(roomId);
        await this.persistence.deleteRoomData(roomId);
        return { closed: true };
      }

      room.members = room.members.filter((member) => member.userId !== userId);
      await this.persistence.saveRoom(room);
      this.meshEvents.memberLeave(roomId, userId);
      return { closed: false, room };
    });
  }

  /** Member-visible mesh reference (the provider owns the actual secret). */
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
      return {
        roomId,
        userId,
        secret: "",
        address: member.meshAddress,
        issuedAt: this.now(),
        expiresAt: room.expiresAt,
      };
    });
  }
}

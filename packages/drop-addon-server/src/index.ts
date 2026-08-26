/**
 * drop-addon-server — Drop server plugin: room orchestration & mesh coordination.
 *
 * Skeleton module layout; the full contract is specified in
 * docs/architecture/SPECIFICATION.md (drop-gse Phase 2).
 *
 * Security note: `Room` is the public view returned by `listRooms` and
 * broadcast over discovery/lifecycle channels; it MUST NOT include the
 * mesh credential. The credential is only ever returned from the
 * authenticated `provisionMeshCredential` call below.
 */

export interface Room {
  /** Unique server-generated room id. */
  id: string;
  /** Drop game version this room is bound to (emulator config must match). */
  gameId: string;
  versionId: string;
  /** Emulator distribution identity enforced for bit-identical configs. */
  emulator: EmulatorBinding;
  hostUserId: string;
  members: RoomMember[];
  /** Public mesh metadata — never the credential itself. */
  mesh: PublicMeshInfo;
  createdAt: number;
  expiresAt: number;
}

export interface RoomMember {
  userId: string;
  /** Mesh identity assigned to this member inside the room subnet. */
  meshAddress?: string;
  joinedAt: number;
}

/**
 * Bit-identical emulator configuration that must be honored across all
 * members of a room.
 */
export interface EmulatorBinding {
  /** Which Goldberg-family fork the room is locked to. */
  flavor: "gbe_fork" | "gse_fork";
  /** Release tag of the emulator distribution — used to gate joiners. */
  release: string;
  /** SHA-256 digest of the emulator binary payload — last-mile integrity. */
  releaseDigest: string;
}

/** Public mesh metadata, safe to broadcast in discovery/lifecycle events. */
export type PublicMeshInfo =
  | { backend: "tailscale"; aclTag: string; expiresAt: number }
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number };

/** Backend-specific reference the client uses to validate its mesh membership. */
export type MeshRoomRef =
  | { backend: "tailscale"; aclTag: string }
  | { backend: "zerotier"; cidr: string; networkId: string };

/**
 * Private mesh credential, only ever returned from the authenticated
 * `provisionMeshCredential` operation.
 */
export interface MeshProvision {
  ref: MeshRoomRef;
  /** Tailscale one-off ephemeral auth key, or ZeroTier invite payload. */
  secret: string;
  expiresAt: number;
}

/**
 * Sanitized room view for unauthenticated discovery callers. Contains only
 * public metadata — no member identities, no credentials.
 */
export interface DiscoverableRoom {
  id: string;
  gameId: string;
  versionId: string;
  emulator: EmulatorBinding;
  mesh: PublicMeshInfo;
  memberCount: number;
  createdAt: number;
  expiresAt: number;
}

export interface RoomRegistry {
  createRoom(
    gameId: string,
    versionId: string,
    emulator: EmulatorBinding,
    hostUserId: string,
  ): Promise<Room>;
  joinRoom(roomId: string, userId: string): Promise<Room>;
  closeRoom(roomId: string): Promise<void>;
  /**
   * Discover rooms, optionally filtered by game. Returns sanitized
   * `DiscoverableRoom` views — never credentials or member identities
   * (member lists are reserved for authenticated member views via
   * `joinRoom`/`Room`).
   */
  listRooms(filter?: { gameId?: string }): Promise<DiscoverableRoom[]>;
  /**
   * Authenticated, membership-checked operation that returns the mesh
   * credential for an approved member of a room.
   */
  provisionMeshCredential(roomId: string, requesterId: string): Promise<MeshProvision>;
}

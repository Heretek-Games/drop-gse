/**
 * drop-addon-server — Drop server plugin: room orchestration & mesh coordination.
 *
 * Skeleton module layout; the full contract is specified in
 * docs/architecture/SPECIFICATION.md (drop-gse Phase 2).
 */

export interface Room {
  id: string;
  /** Drop game version this room is bound to (emulator config must match). */
  gameId: string;
  versionId: string;
  hostUserId: string;
  members: RoomMember[];
  mesh: MeshProvision;
  createdAt: number;
  expiresAt: number;
}

export interface RoomMember {
  userId: string;
  /** Mesh identity assigned to this member inside the room subnet. */
  meshAddress?: string;
  joinedAt: number;
}

/** Per-room ephemeral mesh credential set, distributed to approved members only. */
export interface MeshProvision {
  backend: "tailscale" | "zerotier";
  /** Opaque credential: Tailscale ephemeral auth key or ZeroTier invite payload. */
  secret: string;
  /** IPv4 CIDR of the room's virtual subnet. */
  cidr: string;
  expiresAt: number;
}

export interface RoomRegistry {
  createRoom(gameId: string, versionId: string, hostUserId: string): Promise<Room>;
  joinRoom(roomId: string, userId: string): Promise<Room>;
  closeRoom(roomId: string): Promise<void>;
}

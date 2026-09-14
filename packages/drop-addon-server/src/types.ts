/** Shared types for the drop-gse room coordinator (Track B). */

/** Emulator distribution the room is pinned to (all members must match). */
export interface EmulatorBinding {
  flavor: "gbe_fork" | "gse_fork";
  release: string;
  releaseDigest: string;
}

/** Public mesh metadata, safe to broadcast. Never contains credentials. */
export type PublicMeshInfo =
  | { backend: "tailscale"; aclTag: string; expiresAt: number }
  | { backend: "zerotier"; cidr: string; networkId: string; expiresAt: number };

export interface RoomMember {
  userId: string;
  meshAddress?: string;
  /** Backend node id (e.g. ZeroTier member address) for revocation. */
  meshNodeId?: string;
  joinedAt: number;
}

export interface Room {
  id: string;
  gameId: string;
  versionId: string;
  /** Pinned Steam AppID written to `steam_appid.txt`, when known. */
  appId?: number;
  emulator: EmulatorBinding;
  hostUserId: string;
  /** Last host heartbeat (ms). Used for lease expiry/migration. */
  hostHeartbeatAt: number;
  members: RoomMember[];
  /**
   * Public mesh info as reported by the mesh provider (`drop-zerotier`). Unset
   * until the provider confirms provisioning — drop-gse no longer provisions.
   */
  mesh?: PublicMeshInfo;
  createdAt: number;
  expiresAt: number;
}

/** Sanitized room view for discovery (no member identities). */
export interface DiscoverableRoom {
  id: string;
  gameId: string;
  versionId: string;
  appId?: number;
  emulator: EmulatorBinding;
  mesh?: PublicMeshInfo;
  memberCount: number;
  createdAt: number;
  expiresAt: number;
}

/** Credentials are stored separately and never leave this shape. */
export interface MeshCredential {
  roomId: string;
  userId: string;
  /** Backend-specific secret (e.g. a one-off auth key or network membership). */
  secret: string;
  /** Mesh address assigned to the member, when the backend provides one. */
  address?: string;
  issuedAt: number;
  expiresAt: number;
}

/** Value returned by `MeshBackend.issueCredential`. */
export interface IssuedCredential {
  secret: string;
  address?: string;
  /** Backend-imposed credential lifetime (ms epoch), when shorter than the room. */
  expiresAt?: number;
}

/**
 * Pluggable per-room mesh provider. Implementations must be idempotent:
 * provisioning an existing room returns the same public info, and teardown of
 * an unknown room is a no-op.
 */
export interface MeshBackend {
  readonly id: PublicMeshInfo["backend"];
  provision(roomId: string, expiresAt: number): Promise<PublicMeshInfo>;
  /** Issue (and authorize) a credential for a member; server-side only. */
  issueCredential(roomId: string, userId: string, mesh: PublicMeshInfo): Promise<IssuedCredential>;
  /**
   * Revoke a member's access. No-op if already gone. `mesh`/`memberId` are
   * supplied from persisted room state so revocation works after a coordinator
   * restart (the backend's in-memory maps may be empty).
   */
  revokeMember(
    roomId: string,
    userId: string,
    mesh?: PublicMeshInfo,
    memberId?: string,
  ): Promise<void>;
  /**
   * Authorize a member's node after it has joined the mesh. Returns the address
   * assigned by the backend, when it can report one. `userId` lets the backend
   * remember the node id for later revocation; `mesh` lets it recover the
   * network after a restart; `usedAddresses` lets it avoid reusing a room
   * address already handed to another member.
   */
  authorizeMember?(
    roomId: string,
    userId: string,
    memberId: string,
    mesh?: PublicMeshInfo,
    usedAddresses?: string[],
  ): Promise<string | undefined>;
  /**
   * Remove every node/network for the room. `mesh` is supplied when available
   * so teardown works after a coordinator restart (the in-memory room→network
   * map may be empty).
   */
  teardown(roomId: string, mesh?: PublicMeshInfo): Promise<void>;
}

function isMeshInfo(value: unknown): value is PublicMeshInfo {
  if (!value || typeof value !== "object") return false;
  const mesh = value as { backend?: unknown };
  return mesh.backend === "zerotier" || mesh.backend === "tailscale";
}

function isEmulatorBinding(value: unknown): value is EmulatorBinding {
  if (!value || typeof value !== "object") return false;
  const emulator = value as Partial<EmulatorBinding>;
  return (
    (emulator.flavor === "gbe_fork" || emulator.flavor === "gse_fork") &&
    typeof emulator.release === "string" &&
    typeof emulator.releaseDigest === "string"
  );
}

/** ZeroTier node ids are exactly 10 lowercase/uppercase hex characters. */
export const MESH_MEMBER_ID_PATTERN = /^[0-9a-f]{10}$/i;

export function isMeshMemberId(value: unknown): value is string {
  return typeof value === "string" && MESH_MEMBER_ID_PATTERN.test(value);
}

/** Runtime shape check for a persisted `Room` payload. */
export function isRoom(value: unknown): value is Room {
  if (!value || typeof value !== "object") return false;
  const room = value as Partial<Room>;
  return (
    typeof room.id === "string" &&
    typeof room.gameId === "string" &&
    typeof room.versionId === "string" &&
    typeof room.hostUserId === "string" &&
    typeof room.hostHeartbeatAt === "number" &&
    typeof room.createdAt === "number" &&
    typeof room.expiresAt === "number" &&
    Array.isArray(room.members) &&
    room.members.every((member) => !!member && typeof member.userId === "string") &&
    (room.mesh === undefined || isMeshInfo(room.mesh)) &&
    isEmulatorBinding(room.emulator)
  );
}

export function parseRoom(value: unknown): Room {
  if (!isRoom(value)) {
    throw new Error("corrupt persisted GseRoom payload");
  }
  return value;
}

/** Non-throwing variant for list paths: corrupt rows are skipped, not fatal. */
export function tryParseRoom(value: unknown): Room | undefined {
  return isRoom(value) ? value : undefined;
}

/** Runtime shape check for a persisted `MeshCredential` payload. */
export function isMeshCredential(value: unknown): value is MeshCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Partial<MeshCredential>;
  return (
    typeof credential.roomId === "string" &&
    typeof credential.userId === "string" &&
    typeof credential.secret === "string" &&
    typeof credential.issuedAt === "number" &&
    typeof credential.expiresAt === "number"
  );
}

export function parseCredential(value: unknown): MeshCredential {
  if (!isMeshCredential(value)) {
    throw new Error("corrupt persisted GseCredential payload");
  }
  return value;
}

/**
 * Drop the network identifiers from mesh info for non-member discovery: only
 * authenticated members receive them via their credential/room view.
 */
function redactMesh(mesh: PublicMeshInfo | undefined): PublicMeshInfo | undefined {
  if (!mesh) return undefined;
  if (mesh.backend === "zerotier") {
    return {
      backend: "zerotier",
      cidr: mesh.cidr,
      networkId: "",
      expiresAt: mesh.expiresAt,
    };
  }
  return { backend: "tailscale", aclTag: "", expiresAt: mesh.expiresAt };
}

/**
 * Member-visible room view. Peer mesh node ids are revocation handles, so they
 * are only exposed to the host; other members see addresses but not node ids.
 */
export function toMemberView(room: Room, isHost: boolean): Room {
  if (isHost) return room;
  return {
    ...room,
    members: room.members.map(({ meshNodeId: _meshNodeId, ...member }) => member),
  };
}

export function toDiscoverable(room: Room): DiscoverableRoom {
  return {
    id: room.id,
    gameId: room.gameId,
    versionId: room.versionId,
    appId: room.appId,
    emulator: room.emulator,
    mesh: redactMesh(room.mesh),
    memberCount: room.members.length,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
  };
}

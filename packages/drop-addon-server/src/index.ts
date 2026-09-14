import { createError, readBody } from "h3";
import type {
  PluginContext,
  PluginMetadata,
  ServerPlugin,
} from "@droposs/plugin-sdk";
import { isPublicMeshInfo } from "@heretek-games/zerotier-mesh";
import { CompatRegistry, compatFromEnv } from "./compat.js";
import { StorageRoomPersistence } from "./persistence.js";
import type { RoomPersistence } from "./persistence.js";
import { RoomStore } from "./room-store.js";
import type { MeshEventSink } from "./room-store.js";
import { toDiscoverable, toMemberView } from "./types.js";
import type { EmulatorBinding } from "./types.js";

export type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshCredential,
  PublicMeshInfo,
  Room,
  RoomMember,
} from "./types.js";

/**
 * Plugin API version. Kept as a local literal so the external bundle does not
 * emit a runtime `@droposs/plugin-sdk` import (the SDK is types-only for
 * plugins and is not resolvable from the server's data directory).
 * Keep in sync with `@droposs/plugin-sdk` `PLUGIN_API_VERSION`.
 */
const PLUGIN_API_VERSION = 2;

const DEFAULT_EMULATOR: EmulatorBinding = {
  flavor: "gbe_fork",
  release: "latest",
  releaseDigest: "sha256-default",
};

const PRUNE_INTERVAL_MS = 60_000;

/**
 * Event-bus channels shared with the mesh provider (`drop-zerotier`). drop-gse
 * announces membership; the provider reports provisioned networks and assigned
 * member addresses back.
 */
const MESH_MEMBER_JOIN = "mesh:member-join";
const MESH_MEMBER_LEAVE = "mesh:member-leave";
const MESH_NETWORK_CLOSE = "mesh:network-close";
const MESH_NETWORK = "mesh:network";
const MESH_MEMBER = "mesh:member";

/**
 * Drop GSE multiplayer room coordinator.
 *
 * Rooms are durable (Postgres by default) and mesh-backed by the canonical
 * `drop-zerotier` provider. This plugin owns room/lease/credential lifecycle
 * only: it announces membership over the event bus and consumes the provider's
 * network/member updates.
 */
export class DropGseServerPlugin implements ServerPlugin {
  metadata: PluginMetadata = {
    id: "drop-gse",
    name: "Drop GSE Multiplayer",
    version: "0.3.0",
    description:
      "Peer-to-peer multiplayer rooms over virtual mesh networks using Goldberg Steam emulator",
    author: "Heretek Games",
    builtin: false,
    apiVersion: PLUGIN_API_VERSION,
    trust: "trusted",
    storageVersion: 1,
    capabilities: ["routes", "events", "storage", "websocket"],
    enabled: true,
  };

  private store!: RoomStore;
  private ctx!: PluginContext;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `persistence` defaults to durable plugin storage (`StorageRoomPersistence`)
   * created from `ctx.storage`. Tests may inject another `RoomPersistence` and
   * a `MeshEventSink` to capture delegation events.
   */
  constructor(
    private readonly persistence?: RoomPersistence,
    private readonly meshEvents?: MeshEventSink,
  ) {}

  init(ctx: PluginContext): void {
    this.ctx = ctx;
    const compat = new CompatRegistry(compatFromEnv());
    const sink: MeshEventSink = this.meshEvents ?? {
      memberJoin: (key, userId) => ctx.broadcast(MESH_MEMBER_JOIN, { key, userId }),
      memberLeave: (key, userId) =>
        ctx.broadcast(MESH_MEMBER_LEAVE, { key, userId }),
      networkClose: (key) => ctx.broadcast(MESH_NETWORK_CLOSE, { key }),
    };
    this.store = new RoomStore(
      this.persistence ?? new StorageRoomPersistence(ctx.storage),
      sink,
      Date.now,
      compat,
    );

    // Provide TTL sweep. unref so tests/CLI don't hang on the timer.
    this.pruneTimer = setInterval(() => {
      this.store.pruneExpired().catch(() => {});
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    // Provider reported a provisioned network for a room.
    ctx.subscribe(MESH_NETWORK, (payload) => {
      const data = (payload ?? {}) as { key?: unknown; mesh?: unknown };
      if (typeof data.key !== "string" || !isPublicMeshInfo(data.mesh)) return;
      void this.store
        .setRoomMesh(data.key, data.mesh)
        .then(() => {
          ctx.broadcast("gse:rooms", {
            type: "room_updated",
            roomId: data.key,
          });
        })
        .catch((err) => {
          ctx.logger.warn(`Failed to record room mesh: ${String(err)}`);
        });
    });

    // Provider assigned a mesh address to a member.
    ctx.subscribe(MESH_MEMBER, (payload) => {
      const data = (payload ?? {}) as {
        key?: unknown;
        userId?: unknown;
        address?: unknown;
      };
      if (typeof data.key !== "string" || typeof data.userId !== "string") {
        return;
      }
      const address = typeof data.address === "string" ? data.address : undefined;
      void this.store
        .setMemberMesh(data.key, data.userId, address)
        .then((room) => {
          if (!room) return;
          ctx.broadcast(`gse:room:${room.id}`, {
            type: "member_updated",
            roomId: room.id,
            userId: data.userId,
            meshAddress: address,
          });
          ctx.broadcast("gse:rooms", {
            type: "room_updated",
            room: toDiscoverable(room),
          });
        })
        .catch((err) => {
          ctx.logger.warn(`Failed to record member mesh: ${String(err)}`);
        });
    });

    // WebSocket: authenticated credential distribution. The mesh reference is
    // the provider's; drop-gse never holds a mesh secret.
    ctx.registerWebSocket("gse:credential", async (message, wsCtx) => {
      const payload = (message ?? {}) as { roomId?: string };
      if (!payload.roomId || !wsCtx.userId) {
        wsCtx.send({ ok: false, error: "roomId and authentication required" });
        return;
      }
      try {
        const credential = await this.store.credential(
          payload.roomId,
          wsCtx.userId,
        );
        const room = await this.store.get(payload.roomId);
        wsCtx.send({
          ok: true,
          credential: {
            mesh: room?.mesh,
            secret: credential.secret,
            address: credential.address,
            expiresAt: credential.expiresAt,
          },
        });
      } catch (err) {
        ctx.logger.warn(`Failed to issue GSE credential: ${String(err)}`);
        wsCtx.send({ ok: false, error: "failed to issue credential" });
      }
    });

    // WebSocket: host lease renewal / liveness over the plugin WS gateway.
    ctx.registerWebSocket("gse:heartbeat", async (message, wsCtx) => {
      const payload = (message ?? {}) as { roomId?: string };
      if (!payload.roomId || !wsCtx.userId) {
        wsCtx.send({ ok: false, error: "roomId and authentication required" });
        return;
      }
      try {
        const room = await this.store.heartbeat(payload.roomId, wsCtx.userId);
        wsCtx.send({ ok: true, hostUserId: room.hostUserId });
      } catch {
        wsCtx.send({ ok: false, error: "room not found" });
      }
    });

    // Restrict `gse:room:<id>` subscriptions to room members.
    ctx.registerSubscriptionAuthorizer(
      (channel) => channel.startsWith("gse:room:"),
      async (channel, auth) => {
        if (!auth.userId) return false;
        const room = await this.store.get(channel.slice("gse:room:".length));
        return !!room && room.members.some((member) => member.userId === auth.userId);
      },
    );

    // Route: GET /compat — known-incompatible games/AppIDs.
    ctx.registerRoute("GET", "/compat", () => compat.info());

    // Route: GET /rooms
    ctx.registerRoute("GET", "/rooms", async (_event, context) => {
      await this.store.pruneExpired();
      const gameId =
        typeof context.query.gameId === "string" ? context.query.gameId : undefined;
      return { rooms: await this.store.list(gameId) };
    });

    // Route: POST /rooms
    ctx.registerRoute("POST", "/rooms", async (event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required to host a room",
        });
      }

      const body = await readBody<{
        gameId?: string;
        versionId?: string;
        appId?: number;
        emulator?: EmulatorBinding;
      }>(event);

      if (
        typeof body?.gameId !== "string" ||
        body.gameId.length === 0 ||
        typeof body?.versionId !== "string" ||
        body.versionId.length === 0
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: "gameId and versionId are required",
        });
      }

      try {
        const room = await this.store.create({
          gameId: body.gameId,
          versionId: body.versionId,
          appId: body.appId,
          emulator: body.emulator ?? DEFAULT_EMULATOR,
          hostUserId: context.userId,
        });
        ctx.broadcast("gse:rooms", {
          type: "room_created",
          room: toDiscoverable(room),
        });
        ctx.logger.info(
          `Multiplayer room ${room.id} created for game ${body.gameId} by user ${context.userId}`,
        );
        return { room };
      } catch (err) {
        const message = String(err);
        ctx.logger.warn(`Failed to create GSE room: ${message}`);
        let statusCode = 429;
        let statusMessage = "failed to create multiplayer room";
        if (message.includes("known-incompatible")) {
          statusCode = 409;
          statusMessage = message;
        } else if (message.includes("invalid")) {
          statusCode = 400;
          statusMessage = message;
        }
        throw createError({ statusCode, statusMessage });
      }
    });

    // Route: GET /rooms/:id — full room for members, discovery view otherwise.
    ctx.registerRoute("GET", "/rooms/:id", async (_event, context) => {
      const room = await this.store.get(context.params.id);
      if (!room) {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }
      const isMember =
        !!context.userId &&
        room.members.some((member) => member.userId === context.userId);
      if (isMember) {
        return {
          room: toMemberView(room, context.userId === room.hostUserId),
        };
      }
      return { room: toDiscoverable(room) };
    });

    // Route: POST /rooms/:id/join
    ctx.registerRoute("POST", "/rooms/:id/join", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required to join a room",
        });
      }

      let room;
      try {
        room = await this.store.join(context.params.id, context.userId);
      } catch {
        throw createError({ statusCode: 404, statusMessage: "Room not found" });
      }

      ctx.broadcast(`gse:room:${room.id}`, {
        type: "member_joined",
        roomId: room.id,
        userId: context.userId,
      });
      ctx.broadcast("gse:rooms", {
        type: "room_updated",
        room: toDiscoverable(room),
      });
      return { room: toMemberView(room, room.hostUserId === context.userId) };
    });

    // Route: POST /rooms/:id/heartbeat — host lease renewal / migration.
    ctx.registerRoute("POST", "/rooms/:id/heartbeat", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }
      try {
        const room = await this.store.heartbeat(context.params.id, context.userId);
        return { ok: true, hostUserId: room.hostUserId };
      } catch {
        throw createError({
          statusCode: 404,
          statusMessage: "Room not found",
        });
      }
    });

    // Route: DELETE /rooms/:id
    ctx.registerRoute("DELETE", "/rooms/:id", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }

      const { closed, room } = await this.store.leave(
        context.params.id,
        context.userId,
      );
      if (closed) {
        ctx.broadcast(`gse:room:${context.params.id}`, {
          type: "room_closed",
          roomId: context.params.id,
        });
        ctx.broadcast("gse:rooms", {
          type: "room_closed",
          roomId: context.params.id,
        });
        return { success: true, closed: true };
      }

      ctx.broadcast(`gse:room:${context.params.id}`, {
        type: "member_left",
        roomId: context.params.id,
        userId: context.userId,
      });
      if (room) {
        ctx.broadcast("gse:rooms", {
          type: "room_updated",
          room: toDiscoverable(room),
        });
      }
      return { success: true, closed: false };
    });

    // Route: POST /rooms/:id/credential — membership-gated mesh reference.
    ctx.registerRoute("POST", "/rooms/:id/credential", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }

      let credential;
      try {
        credential = await this.store.credential(
          context.params.id,
          context.userId,
        );
      } catch (err) {
        const message = String(err);
        if (message.includes("not a room member")) {
          throw createError({ statusCode: 403, statusMessage: message });
        }
        throw createError({
          statusCode: 404,
          statusMessage: "Room not found",
        });
      }

      const room = await this.store.get(context.params.id);
      ctx.broadcast(`gse:room:${context.params.id}`, {
        type: "credential_available",
        roomId: context.params.id,
        userId: context.userId,
        expiresAt: credential.expiresAt,
      });
      return {
        credential: {
          mesh: room?.mesh,
          secret: credential.secret,
          address: credential.address,
          expiresAt: credential.expiresAt,
        },
      };
    });
  }

  teardown(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }
}

export const dropGseServerPlugin = new DropGseServerPlugin();

export default dropGseServerPlugin;

import { createError, readBody } from "h3";
import type { PluginContext, PluginMetadata, ServerPlugin } from "@droposs/plugin-sdk";
import { CompatRegistry, compatFromEnv } from "./compat.js";
import {
  InMemoryMeshBackend,
  TailscaleApiProvisioner,
  TailscaleBackend,
  ZeroTierBackend,
} from "./mesh.js";
import { StorageRoomPersistence } from "./persistence.js";
import type { RoomPersistence } from "./persistence.js";
import { RoomStore } from "./room-store.js";
import { ZtnetBackend } from "./mesh.js";
import { isMeshMemberId, toDiscoverable, toMemberView } from "./types.js";
import type { EmulatorBinding, MeshBackend } from "./types.js";

export type {
  DiscoverableRoom,
  EmulatorBinding,
  MeshBackend,
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
 * Drop GSE multiplayer room coordinator.
 *
 * Rooms are durable (Postgres by default) and mesh-backed by one pluggable
 * `MeshBackend`, chosen by `GSE_MESH_BACKEND` or auto-detected: ZTNET (default)
 * → raw ZeroTier → Tailscale → in-memory. The backend is per-deployment;
 * clients cannot switch it.
 */
export class DropGseServerPlugin implements ServerPlugin {
  metadata: PluginMetadata = {
    id: "drop-gse",
    name: "Drop GSE Multiplayer",
    version: "0.2.0",
    description:
      "Peer-to-peer multiplayer rooms over virtual mesh networks using Goldberg Steam emulator",
    author: "Heretek Games",
    builtin: false,
    apiVersion: PLUGIN_API_VERSION,
    trust: "trusted",
    storageVersion: 1,
    capabilities: ["routes", "events", "storage", "network", "websocket"],
    enabled: true,
  };

  private store!: RoomStore;
  private backend!: MeshBackend;
  private ctx!: PluginContext;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * `persistence` defaults to durable plugin storage (`StorageRoomPersistence`)
   * created from `ctx.storage`. Tests may inject another `RoomPersistence`.
   * `backendOverride` overrides the env-selected mesh backend (also tests).
   */
  constructor(
    private readonly persistence?: RoomPersistence,
    private readonly backendOverride?: MeshBackend,
  ) {}

  /**
   * Select the mesh backend from `GSE_MESH_BACKEND` (explicit) or by
   * auto-detecting configured credentials. Auto order: ZTNET → raw ZeroTier →
   * Tailscale → in-memory. An explicit value that is unknown or missing its
   * configuration fails closed instead of silently falling through.
   */
  private resolveBackend(): MeshBackend {
    const selected = (process.env.GSE_MESH_BACKEND ?? "").trim().toLowerCase();

    if (selected === "memory") {
      return new InMemoryMeshBackend();
    }
    if (selected && !["ztnet", "zerotier", "tailscale", "memory"].includes(selected)) {
      throw new Error(
        `unknown GSE_MESH_BACKEND '${selected}' (expected ztnet, zerotier, tailscale or memory)`,
      );
    }
    const selectedOr = (name: string) => selected === "" || selected === name;

    // ZTNET-managed controller is the default path.
    const ztnetUrl = process.env.GSE_ZTNET_URL;
    const ztnetToken = process.env.GSE_ZTNET_TOKEN;
    const ztnetOrg = process.env.GSE_ZTNET_ORG;
    if (selectedOr("ztnet") && ztnetUrl && ztnetToken && ztnetOrg) {
      return new ZtnetBackend({
        baseUrl: ztnetUrl,
        apiToken: ztnetToken,
        organizationId: ztnetOrg,
      });
    }

    const baseUrl = process.env.GSE_ZEROTIER_URL;
    const authToken = process.env.GSE_ZEROTIER_TOKEN;
    const controllerNodeId = process.env.GSE_ZEROTIER_NODE;
    if (selectedOr("zerotier") && baseUrl && authToken && controllerNodeId) {
      return new ZeroTierBackend({ baseUrl, authToken, controllerNodeId });
    }

    const tailscaleKey = process.env.GSE_TAILSCALE_API_KEY;
    const tailnet = process.env.GSE_TAILSCALE_TAILNET;
    if (selectedOr("tailscale") && tailscaleKey && tailnet) {
      return new TailscaleBackend(
        new TailscaleApiProvisioner({
          apiKey: tailscaleKey,
          tailnet,
          tag: process.env.GSE_TAILSCALE_TAG ?? "tag:dropgse",
        }),
      );
    }

    if (selected) {
      throw new Error(
        `GSE_MESH_BACKEND='${selected}' is set but its required configuration is missing`,
      );
    }

    return new InMemoryMeshBackend();
  }

  init(ctx: PluginContext): void {
    this.ctx = ctx;
    const compat = new CompatRegistry(compatFromEnv());
    this.backend = this.backendOverride ?? this.resolveBackend();
    this.store = new RoomStore(
      this.persistence ?? new StorageRoomPersistence(ctx.storage),
      this.backend,
      Date.now,
      compat,
    );

    // B7: periodic TTL sweep. unref so tests/CLI don't hang on the timer.
    this.pruneTimer = setInterval(() => {
      this.store.pruneExpired().catch(() => {});
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    // WebSocket: authenticated credential distribution. The secret is only
    // ever sent to the authenticated peer that requested it.
    ctx.registerWebSocket("gse:credential", async (message, wsCtx) => {
      const payload = (message ?? {}) as { roomId?: string };
      if (!payload.roomId || !wsCtx.userId) {
        wsCtx.send({ ok: false, error: "roomId and authentication required" });
        return;
      }
      try {
        const credential = await this.store.credential(payload.roomId, wsCtx.userId);
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

    // Restrict `gse:room:<id>` subscriptions to room members. Without this any
    // authenticated peer could observe member ids/activity for any room.
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

    // Route: GET /backend — the mesh backend this deployment is configured
    // with. There is exactly one per deployment; clients cannot choose it.
    ctx.registerRoute("GET", "/backend", () => ({
      backend: this.backend.id,
      memory: this.backend instanceof InMemoryMeshBackend,
    }));

    // Route: GET /rooms
    ctx.registerRoute("GET", "/rooms", async (_event, context) => {
      await this.store.pruneExpired();
      const gameId = typeof context.query.gameId === "string" ? context.query.gameId : undefined;
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
        // Only surface our own validation messages; backend/controller errors
        // can carry internal URLs and are logged, not returned.
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
        !!context.userId && room.members.some((member) => member.userId === context.userId);
      if (isMember) {
        // Peer node ids are revocation handles: host-only.
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

    // Route: POST /rooms/:id/member — report this node's mesh member id so the
    // backend can authorize it and assign an address.
    ctx.registerRoute("POST", "/rooms/:id/member", async (event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }
      const body = await readBody<{ memberId?: string }>(event);
      if (!isMeshMemberId(body?.memberId)) {
        throw createError({
          statusCode: 400,
          statusMessage: "memberId must be a 10-character hex ZeroTier node id",
        });
      }
      try {
        const room = await this.store.registerMember(
          context.params.id,
          context.userId,
          body.memberId,
        );
        // Report the address assigned to *this* member so the client can mark
        // its mesh as ready without having to know its own user id.
        const address = room.members.find(
          (member) => member.userId === context.userId,
        )?.meshAddress;
        ctx.broadcast("gse:rooms", {
          type: "room_updated",
          room: toDiscoverable(room),
        });
        return {
          room: toMemberView(room, room.hostUserId === context.userId),
          address,
        };
      } catch (err) {
        const message = String(err);
        ctx.logger.warn(`Failed to register GSE member: ${message}`);
        if (message.includes("not a room member")) {
          throw createError({
            statusCode: 403,
            statusMessage: "not a room member",
          });
        }
        if (message.includes("already registered")) {
          throw createError({
            statusCode: 409,
            statusMessage: "mesh node is already registered to another member",
          });
        }
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

      const { closed, room } = await this.store.leave(context.params.id, context.userId);
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

    // Route: POST /rooms/:id/credential — membership-gated mesh credential.
    ctx.registerRoute("POST", "/rooms/:id/credential", async (_event, context) => {
      if (!context.userId) {
        throw createError({
          statusCode: 401,
          statusMessage: "Authentication required",
        });
      }

      let credential;
      try {
        credential = await this.store.credential(context.params.id, context.userId);
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
      // Notify members a credential is available; the secret itself is only
      // ever returned over this authenticated, membership-checked call.
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

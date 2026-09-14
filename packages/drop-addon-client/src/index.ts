/**
 * drop-addon-client — Drop client plugin: multiplayer launch lifecycle and UI
 * for the Goldberg Steam Emulator over a mesh VPN.
 *
 * All server coordination goes through `ctx.serverRequest`, which the desktop
 * host proxies to the paired server plugin's REST routes (the webview cannot
 * reach the server directly).
 */

import type {
  ClientPlugin,
  ClientPluginContext,
  LaunchContext,
  PlayAction,
  PluginMetadata,
} from "@droposs/plugin-sdk";

/** Client-storage key holding the room this client is currently attached to. */
export const ACTIVE_ROOM_KEY = "gse:activeRoom";

/** Emulator configuration written into the game directory before launch. */
export const STEAM_SETTINGS_DIR = "steam_settings";
export const STEAM_SETTINGS_INI = `${STEAM_SETTINGS_DIR}/settings.ini`;
export const STEAM_APPID_FILE = "steam_appid.txt";
export const CUSTOM_BROADCASTS_FILE = "custom_broadcasts.txt";

/** Steam binaries backed up and restored around a multiplayer launch. */
export const STEAM_BINARIES = ["steam_api.dll", "steam_api64.dll"] as const;

export interface RoomMember {
  userId: string;
  meshAddress?: string;
  meshNodeId?: string;
  joinedAt: number;
}

export interface DiscoverableRoom {
  id: string;
  gameId: string;
  versionId: string;
  appId?: number;
  memberCount: number;
  createdAt: number;
  expiresAt: number;
}

export interface MemberRoom extends DiscoverableRoom {
  hostUserId: string;
  members: RoomMember[];
  /** Provider-reported mesh reference; join is owned by drop-zerotier. */
  mesh?: unknown;
}

/** The slice of room state persisted between the play action and launch. */
export interface ActiveRoom {
  roomId: string;
  gameId: string;
  versionId: string;
  appId?: number;
  peers: string[];
  expiresAt: number;
}

function toActiveRoom(room: MemberRoom): ActiveRoom {
  const peers = (room.members ?? [])
    .map((member) => member.meshAddress)
    .filter((address): address is string => Boolean(address));
  return {
    roomId: room.id,
    gameId: room.gameId,
    versionId: room.versionId,
    appId: room.appId,
    peers,
    expiresAt: room.expiresAt,
  };
}

/**
 * Drop GSE multiplayer client plugin.
 *
 * Responsibilities:
 * - Offer a "Play with GSE Multiplayer" action that attaches this client to a
 *   room for the game.
 * - Run the launch pipeline: fail-closed anti-cheat validation, DLL backup and
 *   emulator config staging, then restore on exit.
 */
export class DropGseClientPlugin implements ClientPlugin {
  metadata: PluginMetadata = {
    id: "drop-gse",
    name: "Drop GSE Multiplayer",
    version: "0.3.0",
    description:
      "Peer-to-peer multiplayer rooms over virtual mesh networks using the Goldberg Steam emulator",
    author: "Heretek Games",
    apiVersion: 2,
    trust: "trusted",
    targets: ["client" as const],
    capabilities: [
      "ui:slot",
      "ui:play-action",
      "game:launch-hook",
      "game:fs",
      "game:scan",
      "client:storage",
      "client:ws",
    ],
  };

  init(ctx: ClientPluginContext): void {
    ctx.registerPlayAction((gameId) => this.playActions(ctx, gameId));

    ctx.registerSlot(
      "game-detail:actions",
      {
        template: '<span class="text-xs text-zinc-400">GSE multiplayer ready</span>',
      },
      { label: "GSE Multiplayer", order: 50 },
    );

    ctx.registerLaunchHook({
      stage: "pre-launch:validate",
      order: 10,
      execute: (launch) => this.validate(ctx, launch),
    });
    ctx.registerLaunchHook({
      stage: "pre-launch:stage",
      order: 10,
      execute: (launch) => this.stage(ctx, launch),
    });
    ctx.registerLaunchHook({
      stage: "post-exit:restore",
      order: 10,
      execute: (launch) => this.restore(ctx, launch),
    });
  }

  /**
   * Offer a room-join action for every joinable room of this game. When no room
   * exists the action list is empty; the core library UI still advertises that
   * multiplayer requires the extension.
   */
  private async playActions(ctx: ClientPluginContext, gameId: string): Promise<PlayAction[]> {
    let rooms: DiscoverableRoom[] = [];
    try {
      const res = await ctx.serverRequest<{ rooms: DiscoverableRoom[] }>(
        "GET",
        `/rooms?gameId=${encodeURIComponent(gameId)}`,
      );
      rooms = res?.rooms ?? [];
    } catch (err) {
      ctx.logger.warn(`Failed to list GSE rooms for ${gameId}: ${String(err)}`);
      return [];
    }

    return rooms.map((room) => ({
      id: `gse-join-${room.id}`,
      name: `Join GSE room (${room.memberCount} player${room.memberCount === 1 ? "" : "s"})`,
      icon: "heroicons:user-group",
      execute: (launch) => this.joinRoom(ctx, room.id, launch),
    }));
  }

  /** Join a room and persist the resulting peer list for the launch pipeline. */
  private async joinRoom(
    ctx: ClientPluginContext,
    roomId: string,
    _launch: LaunchContext,
  ): Promise<void> {
    const res = await ctx.serverRequest<{ room: MemberRoom }>(
      "POST",
      `/rooms/${encodeURIComponent(roomId)}/join`,
    );
    if (!res?.room) {
      throw new Error(`GSE room ${roomId} did not return room state`);
    }
    await ctx.storage.set(ACTIVE_ROOM_KEY, toActiveRoom(res.room));
    ctx.logger.info(`Joined GSE room ${roomId}`);
  }

  private async activeRoom(ctx: ClientPluginContext, gameId: string): Promise<ActiveRoom | null> {
    const room = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
    if (!room || room.gameId !== gameId) return null;
    if (room.expiresAt && room.expiresAt < Date.now()) {
      await ctx.storage.delete(ACTIVE_ROOM_KEY);
      return null;
    }
    return room;
  }

  /**
   * Fail-closed anti-cheat gate. Any detection aborts the launch so a modified
   * `steam_api` binary can never be presented to EasyAntiCheat/BattlEye.
   */
  private async validate(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    const room = await this.activeRoom(ctx, launch.gameId);
    if (!room) return;

    const report = await ctx.gameScanner.checkAntiCheat(launch.gameId);
    if (report.detected) {
      const detail =
        report.reason ??
        (report.binaries && report.binaries.length > 0
          ? report.binaries.join(", ")
          : "anti-cheat binaries present");
      throw new Error(`GSE multiplayer aborted for "${launch.gameTitle}": ${detail}`);
    }
  }

  /**
   * Back up the original Steam binaries and stage emulator configuration for
   * the active room. Everything is confined to the game directory by the host.
   */
  private async stage(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    const room = await this.activeRoom(ctx, launch.gameId);
    if (!room) return;

    for (const binary of STEAM_BINARIES) {
      if (await ctx.gameFs.fileExists(launch.gameId, binary)) {
        await ctx.gameFs.backupFile(launch.gameId, binary);
      }
    }

    await ctx.gameFs.writeFile(launch.gameId, STEAM_APPID_FILE, `${room.appId ?? ""}\n`);
    await ctx.gameFs.writeFile(launch.gameId, CUSTOM_BROADCASTS_FILE, `${room.peers.join("\n")}\n`);
    await ctx.gameFs.writeFile(
      launch.gameId,
      STEAM_SETTINGS_INI,
      [
        "[Settings]",
        `room_id=${room.roomId}`,
        `version_id=${room.versionId}`,
        `peer_count=${room.peers.length}`,
        "",
      ].join("\n"),
    );
    ctx.logger.info(`Staged GSE config for room ${room.roomId}`);
  }

  /** Restore backed-up binaries and remove staged emulator config. */
  private async restore(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    for (const binary of STEAM_BINARIES) {
      if (await ctx.gameFs.fileExists(launch.gameId, binary)) {
        await ctx.gameFs.restoreFile(launch.gameId, binary).catch(() => {});
      }
    }
    for (const file of [STEAM_APPID_FILE, CUSTOM_BROADCASTS_FILE, STEAM_SETTINGS_INI]) {
      await ctx.gameFs.deleteFile(launch.gameId, file).catch(() => {});
    }
    await ctx.storage.delete(ACTIVE_ROOM_KEY).catch(() => {});
  }
}

export const dropGseClientPlugin = new DropGseClientPlugin();

export default dropGseClientPlugin;

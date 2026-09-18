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

import { planAchievementSync, readLocalSavePath } from "./achievements.js";
import { GseSidecar } from "./sidecar.js";

export * from "./sidecar.js";

/** Client-storage key holding the room this client is currently attached to. */
export const ACTIVE_ROOM_KEY = "gse:activeRoom";

/** Emulator configuration written into the game directory before launch. */
export const STEAM_SETTINGS_DIR = "steam_settings";
export const STEAM_SETTINGS_MAIN_INI = `${STEAM_SETTINGS_DIR}/configs.main.ini`;
export const STEAM_SETTINGS_APPID_FILE = `${STEAM_SETTINGS_DIR}/steam_appid.txt`;
export const STEAM_SETTINGS_BROADCASTS_FILE = `${STEAM_SETTINGS_DIR}/custom_broadcasts.txt`;
export const STEAM_SETTINGS_INTERFACES_FILE = `${STEAM_SETTINGS_DIR}/steam_interfaces.txt`;
export const STEAM_SETTINGS_INI = `${STEAM_SETTINGS_DIR}/settings.ini`;
export const STEAM_APPID_FILE = "steam_appid.txt";
export const CUSTOM_BROADCASTS_FILE = "custom_broadcasts.txt";

/**
 * Minimal `configs.main.ini` for Goldberg-family emulators.
 * Enables connectivity and binds to UDP 47584.
 */
export function renderConfigsMainIni(flavor: "gbe_fork" | "gse_fork" = "gbe_fork"): string {
  const listenerKey = flavor === "gse_fork" ? "listen_port" : "listener_port";
  return [
    "[main::connectivity]",
    `${listenerKey}=47584`,
    "disable_lan_only=0",
    "disable_networking=0",
    "",
  ].join("\n");
}

/**
 * Format custom broadcasts for Goldberg: one peer per line, with default port 47584.
 */
export function renderCustomBroadcasts(peers: string[]): string {
  if (peers.length === 0) {
    return "127.0.0.1:47584\n";
  }
  return peers.map((peer) => (peer.includes(":") ? peer : `${peer}:47584`)).join("\n") + "\n";
}

const INTERFACE_PATTERN = /Steam[A-Z][A-Za-z0-9_]*[0-9]{3}/g;

/**
 * Scans binary bytes for Steam interface identifiers (e.g. SteamUser021).
 */
export function extractInterfacesFromBytes(bytes: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(bytes);
  const matches = text.match(INTERFACE_PATTERN);
  if (!matches) return [];
  return Array.from(new Set(matches)).sort();
}

/** Achievement definitions and portable save location written by the emulator. */
export const ACHIEVEMENTS_DEFINITIONS_FILE = `${STEAM_SETTINGS_DIR}/achievements.json`;
export const PORTABLE_SAVE_CONFIG_FILE = `${STEAM_SETTINGS_DIR}/configs.user.ini`;
export const PORTABLE_SAVE_DIR = "gse_saves";
export const ACHIEVEMENTS_KNOWN_KEY_PREFIX = "gse:achievements:";

/** Client-storage flag: this launch created the portable-save config itself. */
export const PORTABLE_SAVE_STAGED_KEY = "gse:portableSaveStaged";

/** Core endpoint receiving one unlock request per newly earned achievement. */
export const ACHIEVEMENTS_UNLOCK_PATH = "/api/v1/client/achievements/unlock";

/** Steam binaries backed up and restored around a multiplayer launch. */
export const STEAM_BINARIES = ["steam_api.dll", "steam_api64.dll"] as const;

/**
 * Anti-cheat providers and the path fragments that identify them. This domain
 * knowledge lives in the plugin rather than the generic client host, which
 * only exposes a pattern-based `findFiles` primitive.
 */
export const ANTICHEAT_PROVIDERS: ReadonlyArray<{
  provider: string;
  patterns: readonly string[];
}> = [
  {
    provider: "easyanticheat",
    patterns: ["easyanticheat", "eac_server", "easyanticheat_x64.dll"],
  },
  { provider: "battleye", patterns: ["battleye", "beservice", "beclient"] },
  { provider: "vanguard", patterns: ["vgk.sys", "vgc.exe"] },
  { provider: "denuvo", patterns: ["denuvo", "dbdata.dll"] },
];

const ANTICHEAT_PATTERNS: string[] = ANTICHEAT_PROVIDERS.flatMap((entry) => [...entry.patterns]);

/**
 * Host scanner capabilities this plugin uses, typed structurally so it keeps
 * compiling against SDK versions that expose either the generic `findFiles`
 * primitive or the legacy `checkAntiCheat` method.
 */
interface AntiCheatScannerCaps {
  findFiles?: (gameId: string, patterns: string[]) => Promise<string[]>;
  checkAntiCheat?: (gameId: string) => Promise<{
    detected: boolean;
    provider?: string;
    reason?: string;
    binaries?: string[];
    files?: string[];
  }>;
}

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
  isHost?: boolean;
  gameDir?: string;
}

function toActiveRoom(room: MemberRoom, isHost?: boolean, gameDir?: string): ActiveRoom {
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
    isHost,
    gameDir,
  };
}

/** Order-insensitive peer-address comparison for refresh short-circuiting. */
function samePeers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((peer) => set.has(peer));
}

/**
 * Paths (relative to the game directory) where Goldberg-family emulators keep
 * runtime unlock state. `configuredPath` comes from the user's own
 * `configs.user.ini` when present.
 */
export function achievementSaveCandidates(appId: number, configuredPath?: string): string[] {
  const roots = [
    configuredPath,
    PORTABLE_SAVE_DIR,
    `${STEAM_SETTINGS_DIR}/${PORTABLE_SAVE_DIR}`,
    "GSE Saves",
    STEAM_SETTINGS_DIR,
  ].filter((root): root is string => typeof root === "string" && root.length > 0);

  const candidates: string[] = [];
  for (const root of roots) {
    let normalized = root.replaceAll("\\", "/");
    while (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    const candidate = `${normalized}/${appId}/achievements.json`;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export interface GseRecoveryResult {
  recovered: boolean;
  restored: string[];
  removedStagedConfig: boolean;
}

/**
 * Crash-recovery sweep (M4). A previous session may have patched the Steam
 * binaries and staged emulator config without a clean `post-exit:restore`
 * (game crash, host kill, power loss). If a room is still recorded as active,
 * restore any backups and remove staged files before doing anything else so a
 * later launch starts from the original game.
 */
export async function recoverInterruptedSession(
  ctx: ClientPluginContext,
  sidecar?: GseSidecar,
): Promise<GseRecoveryResult> {
  const room = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
  if (!room?.gameId) {
    return { recovered: false, restored: [], removedStagedConfig: false };
  }

  ctx.logger.warn(`Recovering interrupted GSE session for ${room.gameId}`);

  const restored: string[] = [];
  const runner = sidecar ?? new GseSidecar(ctx.system);

  if (room.gameDir && (await runner.isAvailable())) {
    try {
      const res = await runner.restore({ gameDir: room.gameDir });
      restored.push(...res.restored);
    } catch (err) {
      ctx.logger.warn(`Sidecar crash recovery failed for ${room.gameDir}: ${String(err)}`);
    }
  }

  // Restore engine-tracked targets recorded in .drop-gse-manifest.json
  if (await ctx.gameFs.fileExists(room.gameId, ".drop-gse-manifest.json")) {
    try {
      const manifestBytes = await ctx.gameFs.readFile(room.gameId, ".drop-gse-manifest.json");
      const manifestStr = new TextDecoder().decode(manifestBytes);
      const manifest = JSON.parse(manifestStr) as { entries?: Record<string, string> };
      if (manifest?.entries) {
        for (const target of Object.keys(manifest.entries)) {
          const origFile = `${target}.orig`;
          if (await ctx.gameFs.fileExists(room.gameId, origFile)) {
            const origBytes = await ctx.gameFs.readFile(room.gameId, origFile);
            await ctx.gameFs.writeFile(room.gameId, target, origBytes);
            await ctx.gameFs.deleteFile(room.gameId, origFile);
            if (!restored.includes(target)) {
              restored.push(target);
            }
          }
        }
      }
      await ctx.gameFs.deleteFile(room.gameId, ".drop-gse-manifest.json");
    } catch (err) {
      ctx.logger.warn(`Failed to process engine manifest during recovery: ${String(err)}`);
    }
  }

  // Restore any pre-existing user emulator configs that were backed up as .drop-gse-backup
  for (const file of ["configs.main.ini", "steam_interfaces.txt"]) {
    const backupFile = `${STEAM_SETTINGS_DIR}/${file}.drop-gse-backup`;
    const targetFile = `${STEAM_SETTINGS_DIR}/${file}`;
    if (await ctx.gameFs.fileExists(room.gameId, backupFile)) {
      try {
        const backupBytes = await ctx.gameFs.readFile(room.gameId, backupFile);
        await ctx.gameFs.writeFile(room.gameId, targetFile, backupBytes);
        await ctx.gameFs.deleteFile(room.gameId, backupFile);
      } catch {
        // Continue best-effort
      }
    }
  }

  // Restore any remaining *.orig binaries or host .drop-backup files for STEAM_BINARIES
  for (const binary of STEAM_BINARIES) {
    const origFile = `${binary}.orig`;
    if (await ctx.gameFs.fileExists(room.gameId, origFile)) {
      try {
        const origBytes = await ctx.gameFs.readFile(room.gameId, origFile);
        await ctx.gameFs.writeFile(room.gameId, binary, origBytes);
        await ctx.gameFs.deleteFile(room.gameId, origFile);
        if (!restored.includes(binary)) {
          restored.push(binary);
        }
      } catch {
        // Continue best-effort
      }
    }

    if (await ctx.gameFs.fileExists(room.gameId, binary)) {
      try {
        await ctx.gameFs.restoreFile(room.gameId, binary);
        if (!restored.includes(binary)) {
          restored.push(binary);
        }
      } catch {
        // No backup exists (fresh emulator binary); nothing to restore.
      }
    }
  }

  let removedStagedConfig = false;
  if (await ctx.storage.get<boolean>(PORTABLE_SAVE_STAGED_KEY)) {
    try {
      await ctx.gameFs.deleteFile(room.gameId, PORTABLE_SAVE_CONFIG_FILE);
      removedStagedConfig = true;
    } catch {
      // Already gone.
    }
  }
  for (const file of [
    STEAM_SETTINGS_MAIN_INI,
    STEAM_SETTINGS_APPID_FILE,
    STEAM_SETTINGS_BROADCASTS_FILE,
    STEAM_SETTINGS_INTERFACES_FILE,
    STEAM_SETTINGS_INI,
    STEAM_APPID_FILE,
    CUSTOM_BROADCASTS_FILE,
  ]) {
    await ctx.gameFs.deleteFile(room.gameId, file).catch(() => {});
  }

  if (room.roomId) {
    try {
      await ctx.serverRequest("DELETE", `/rooms/${encodeURIComponent(room.roomId)}`);
    } catch {
      // Best-effort during crash recovery.
    }
  }

  await ctx.storage.delete(PORTABLE_SAVE_STAGED_KEY).catch(() => {});
  await ctx.storage.delete(ACTIVE_ROOM_KEY).catch(() => {});

  return { recovered: true, restored, removedStagedConfig };
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
    version: "0.3.1",
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
      "system:sidecar",
      "system:command",
    ],
  };

  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sidecar?: GseSidecar;

  private getSidecar(ctx: ClientPluginContext): GseSidecar {
    if (!this.sidecar) {
      this.sidecar = new GseSidecar(ctx.system);
    }
    return this.sidecar;
  }

  teardown(): void {
    this.stopHeartbeat();
  }

  private startHeartbeat(ctx: ClientPluginContext, roomId: string): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void ctx
        .serverRequest("POST", `/rooms/${encodeURIComponent(roomId)}/heartbeat`)
        .catch((err: unknown) => {
          ctx.logger.debug(`GSE heartbeat failed: ${String(err)}`);
        });
    }, 15_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  async init(ctx: ClientPluginContext): Promise<void> {
    const sidecar = this.getSidecar(ctx);
    await recoverInterruptedSession(ctx, sidecar).catch((err: unknown) => {
      ctx.logger.warn(`GSE crash recovery failed: ${String(err)}`);
    });

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
      stage: "pre-launch:network-post",
      order: 50,
      execute: (launch) => this.refreshBroadcasts(ctx, launch),
    });
    ctx.registerLaunchHook({
      stage: "post-exit:restore",
      order: 10,
      execute: (launch) => this.restore(ctx, launch),
    });
  }

  /**
   * Offer room actions for this game: always offer "Host GSE Multiplayer Room"
   * plus join actions for each active room found.
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

    const actions: PlayAction[] = [
      {
        id: `gse-host-${gameId}`,
        name: "Host GSE Multiplayer Room",
        icon: "heroicons:plus-circle",
        execute: (launch) => this.hostRoom(ctx, launch),
      },
    ];

    for (const room of rooms) {
      actions.push({
        id: `gse-join-${room.id}`,
        name: `Join GSE room (${room.memberCount} player${room.memberCount === 1 ? "" : "s"})`,
        icon: "heroicons:user-group",
        execute: (launch) => this.joinRoom(ctx, room.id, launch),
      });
    }

    return actions;
  }

  /** Host a new room for this game and persist the resulting room state. */
  private async hostRoom(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    const versionId =
      typeof launch.metadata?.versionId === "string" && launch.metadata.versionId.length > 0
        ? launch.metadata.versionId
        : "1.0.0";
    const appId =
      typeof launch.metadata?.appId === "number"
        ? launch.metadata.appId
        : Number.isInteger(Number(launch.gameId)) && Number(launch.gameId) > 0
          ? Number(launch.gameId)
          : undefined;

    const res = await ctx.serverRequest<{ room: MemberRoom }>("POST", "/rooms", {
      gameId: launch.gameId,
      versionId,
      appId,
    });
    if (!res?.room) {
      throw new Error(`Failed to create GSE room for ${launch.gameId}`);
    }
    await ctx.storage.set(ACTIVE_ROOM_KEY, toActiveRoom(res.room, true, launch.gameDir));
    ctx.logger.info(`Hosted GSE room ${res.room.id} for ${launch.gameId}`);
  }

  /** Join a room and persist the resulting peer list for the launch pipeline. */
  private async joinRoom(
    ctx: ClientPluginContext,
    roomId: string,
    launch: LaunchContext,
  ): Promise<void> {
    const res = await ctx.serverRequest<{ room: MemberRoom }>(
      "POST",
      `/rooms/${encodeURIComponent(roomId)}/join`,
    );
    if (!res?.room) {
      throw new Error(`GSE room ${roomId} did not return room state`);
    }
    await ctx.storage.set(ACTIVE_ROOM_KEY, toActiveRoom(res.room, false, launch.gameDir));
    ctx.logger.info(`Joined GSE room ${roomId}`);
  }

  private async activeRoom(ctx: ClientPluginContext, gameId: string): Promise<ActiveRoom | null> {
    const room = await ctx.storage.get<ActiveRoom>(ACTIVE_ROOM_KEY);
    if (room?.gameId !== gameId) return null;
    if (room.expiresAt && room.expiresAt < Date.now()) {
      await ctx.storage.delete(ACTIVE_ROOM_KEY);
      return null;
    }
    return room;
  }

  /**
   * Fail-closed anti-cheat gate. Any detection aborts the launch so a modified
   * `steam_api` binary can never be presented to EasyAntiCheat/BattlEye.
   *
   * Queries the server compatibility registry for blocked AppIDs/GameIDs,
   * probes the native `gse-engine` sidecar for directory scanning when available,
   * and falls back to host scanner primitives (`findFiles`/`checkAntiCheat`).
   */
  private async validate(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    const room = await this.activeRoom(ctx, launch.gameId);
    if (!room) return;

    // Check server compatibility registry
    try {
      const compat = await ctx.serverRequest<{
        blockedAppIds?: number[];
        blockedGameIds?: string[];
      }>("GET", "/compat");
      if (compat) {
        if (compat.blockedGameIds?.includes(launch.gameId)) {
          throw new Error(
            `Game "${launch.gameTitle}" (${launch.gameId}) is known-incompatible with GSE multiplayer`,
          );
        }
        if (room.appId !== undefined && compat.blockedAppIds?.includes(room.appId)) {
          throw new Error(
            `Steam AppID ${room.appId} is known-incompatible with GSE multiplayer (anti-cheat protected)`,
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("known-incompatible")) {
        throw err;
      }
      ctx.logger.debug(`GSE compat check skipped or unavailable: ${String(err)}`);
    }

    const sidecar = this.getSidecar(ctx);
    if (await sidecar.isAvailable()) {
      try {
        const scan = await sidecar.scan(launch.gameDir);
        if (scan.antiCheat) {
          throw new Error(
            `GSE multiplayer aborted for "${launch.gameTitle}": anti-cheat marker detected (${scan.antiCheat})`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("GSE multiplayer aborted")) {
          throw err;
        }
        throw new Error(
          `GSE multiplayer aborted for "${launch.gameTitle}": anti-cheat scan failed (${String(err)})`,
          { cause: err },
        );
      }
    } else {
      const detection = await this.detectAntiCheat(ctx, launch.gameId);
      if (detection) {
        throw new Error(`GSE multiplayer aborted for "${launch.gameTitle}": ${detection.detail}`);
      }
    }
  }

  private async detectAntiCheat(
    ctx: ClientPluginContext,
    gameId: string,
  ): Promise<{ provider?: string; detail: string } | undefined> {
    const scanner = ctx.gameScanner as unknown as AntiCheatScannerCaps;

    if (typeof scanner.findFiles === "function") {
      const matches = await scanner.findFiles(gameId, ANTICHEAT_PATTERNS);
      if (matches.length === 0) return undefined;
      const lowered = matches.map((match) => match.toLowerCase());
      const provider = ANTICHEAT_PROVIDERS.find(({ patterns }) =>
        patterns.some((pattern) => lowered.some((match) => match.includes(pattern.toLowerCase()))),
      )?.provider;
      return { provider, detail: matches.join(", ") };
    }

    if (typeof scanner.checkAntiCheat === "function") {
      const report = await scanner.checkAntiCheat(gameId);
      if (!report.detected) return undefined;
      const detail =
        report.reason ??
        (report.binaries && report.binaries.length > 0
          ? report.binaries.join(", ")
          : report.files && report.files.length > 0
            ? report.files.join(", ")
            : "anti-cheat binaries present");
      return { provider: report.provider, detail };
    }

    throw new Error(
      "GSE anti-cheat preflight unavailable: the client host exposes no file-scanning capability",
    );
  }

  /**
   * Back up original Steam binaries, harvest interface names, and stage emulator
   * configuration for the active room.
   */
  private async stage(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    const room = await this.activeRoom(ctx, launch.gameId);
    if (!room) return;

    if (!room.gameDir) {
      room.gameDir = launch.gameDir;
      await ctx.storage.set(ACTIVE_ROOM_KEY, room);
    }

    const sidecar = this.getSidecar(ctx);
    if (await sidecar.isAvailable()) {
      await sidecar.patch({
        gameDir: launch.gameDir,
        appId: room.appId ?? 480,
        peers: room.peers,
      });

      // Write root & legacy files for maximum compatibility
      const appidContent = `${room.appId ?? ""}\n`;
      await ctx.gameFs.writeFile(launch.gameId, STEAM_APPID_FILE, appidContent).catch(() => {});
      await ctx.gameFs
        .writeFile(launch.gameId, CUSTOM_BROADCASTS_FILE, `${room.peers.join("\n")}\n`)
        .catch(() => {});
      await ctx.gameFs
        .writeFile(
          launch.gameId,
          STEAM_SETTINGS_INI,
          [
            "[Settings]",
            `room_id=${room.roomId}`,
            `version_id=${room.versionId}`,
            `peer_count=${room.peers.length}`,
            "",
          ].join("\n"),
        )
        .catch(() => {});
    } else {
      // Harvest interface names from pre-patch binaries before modifying them
      const interfaces: string[] = [];
      for (const binary of STEAM_BINARIES) {
        if (await ctx.gameFs.fileExists(launch.gameId, binary)) {
          try {
            const bytes = await ctx.gameFs.readFile(launch.gameId, binary);
            interfaces.push(...extractInterfacesFromBytes(bytes));
          } catch {
            // Non-critical: continue
          }
          await ctx.gameFs.backupFile(launch.gameId, binary);
        }
      }

      const uniqueInterfaces = Array.from(new Set(interfaces)).sort();
      if (uniqueInterfaces.length > 0) {
        await ctx.gameFs.writeFile(
          launch.gameId,
          STEAM_SETTINGS_INTERFACES_FILE,
          uniqueInterfaces.join("\n") + "\n",
        );
      }

      const broadcasts = renderCustomBroadcasts(room.peers);
      const mainIni = renderConfigsMainIni();
      const appidContent = `${room.appId ?? ""}\n`;

      // Write standard steam_settings/ tree
      await ctx.gameFs.writeFile(launch.gameId, STEAM_SETTINGS_MAIN_INI, mainIni);
      await ctx.gameFs.writeFile(launch.gameId, STEAM_SETTINGS_APPID_FILE, appidContent);
      await ctx.gameFs.writeFile(launch.gameId, STEAM_SETTINGS_BROADCASTS_FILE, broadcasts);

      // Also write root & legacy files for maximum compatibility
      await ctx.gameFs.writeFile(launch.gameId, STEAM_APPID_FILE, appidContent);
      await ctx.gameFs.writeFile(
        launch.gameId,
        CUSTOM_BROADCASTS_FILE,
        `${room.peers.join("\n")}\n`,
      );
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
    }

    await this.stageAchievementSaves(ctx, launch);
    this.startHeartbeat(ctx, room.roomId);
    ctx.logger.info(`Staged GSE config for room ${room.roomId}`);
  }

  /**
   * Gap C (broadcast race) fix. `pre-launch:stage` freezes
   * `custom_broadcasts.txt` from peers cached in client storage, but the
   * ZeroTier mesh addresses are only assigned during `pre-launch:network`.
   * This hook runs after the network stage and right before the game process
   * spawns: it re-fetches the room, and when the assigned mesh addresses
   * differ from the staged ones, rewrites the broadcast files and the staged
   * room state.
   *
   * Best-effort by design: a failed refresh still launches with the
   * stage-3 bootstrap list rather than aborting the game.
   */
  private async refreshBroadcasts(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    const room = await this.activeRoom(ctx, launch.gameId);
    if (!room) return;

    let freshPeers: string[] = room.peers;
    try {
      // Brief retry: the mesh address is assigned by the server right after
      // the ZeroTier plugin's join hook reports the node, so one or two
      // short waits cover the provisioning race.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const res = await ctx.serverRequest<{ room: MemberRoom }>(
          "GET",
          `/rooms/${encodeURIComponent(room.roomId)}`,
        );
        const members = res?.room?.members ?? [];
        const addresses = members
          .map((member) => member.meshAddress)
          .filter((address): address is string => Boolean(address));
        if (addresses.length > 0) {
          freshPeers = addresses;
          break;
        }
      }
    } catch (err) {
      ctx.logger.warn(
        `GSE broadcast refresh failed for room ${room.roomId}; keeping staged peer list: ${String(err)}`,
      );
      return;
    }

    if (samePeers(freshPeers, room.peers)) {
      ctx.logger.debug(`GSE broadcast list already current for room ${room.roomId}`);
      return;
    }

    // Rewrite the broadcast files (root + steam_settings/) and the staged
    // room state. Binaries stay patched from `pre-launch:stage`; only the
    // Goldberg discovery config changes.
    const broadcastContent = renderCustomBroadcasts(freshPeers);
    await ctx.gameFs
      .writeFile(launch.gameId, STEAM_SETTINGS_BROADCASTS_FILE, broadcastContent)
      .catch(() => {});
    await ctx.gameFs
      .writeFile(launch.gameId, CUSTOM_BROADCASTS_FILE, `${freshPeers.join("\n")}\n`)
      .catch(() => {});
    await ctx.gameFs
      .writeFile(
        launch.gameId,
        STEAM_SETTINGS_INI,
        [
          "[Settings]",
          `room_id=${room.roomId}`,
          `version_id=${room.versionId}`,
          `peer_count=${freshPeers.length}`,
          "",
        ].join("\n"),
      )
      .catch(() => {});

    await ctx.storage.set(ACTIVE_ROOM_KEY, { ...room, peers: freshPeers });
    ctx.logger.info(
      `Refreshed GSE broadcasts for room ${room.roomId}: ${room.peers.length} -> ${freshPeers.length} peers`,
    );
  }

  /**
   * Point the emulator's saves at the game directory so the post-exit hook can
   * read unlock state through the scoped filesystem. A pre-existing
   * `configs.user.ini` is never overwritten.
   */
  private async stageAchievementSaves(
    ctx: ClientPluginContext,
    launch: LaunchContext,
  ): Promise<void> {
    if (await ctx.gameFs.fileExists(launch.gameId, PORTABLE_SAVE_CONFIG_FILE)) {
      return;
    }
    await ctx.gameFs.writeFile(
      launch.gameId,
      PORTABLE_SAVE_CONFIG_FILE,
      `[user::saves]\nlocal_save_path=${PORTABLE_SAVE_DIR}\n`,
    );
    await ctx.storage.set(PORTABLE_SAVE_STAGED_KEY, true);
  }

  /** Restore backed-up binaries, remove staged config, leave room, then report unlocks. */
  private async restore(ctx: ClientPluginContext, launch: LaunchContext): Promise<void> {
    this.stopHeartbeat();
    const room = await this.activeRoom(ctx, launch.gameId);

    const sidecar = this.getSidecar(ctx);
    if (await sidecar.isAvailable()) {
      try {
        await sidecar.restore({ gameDir: launch.gameDir });
      } catch (err) {
        ctx.logger.warn(`Sidecar restore failed: ${String(err)}`);
      }
    }

    for (const binary of STEAM_BINARIES) {
      if (await ctx.gameFs.fileExists(launch.gameId, binary)) {
        await ctx.gameFs.restoreFile(launch.gameId, binary).catch(() => {});
      }
      const origFile = `${binary}.orig`;
      if (await ctx.gameFs.fileExists(launch.gameId, origFile)) {
        try {
          const origBytes = await ctx.gameFs.readFile(launch.gameId, origFile);
          await ctx.gameFs.writeFile(launch.gameId, binary, origBytes);
          await ctx.gameFs.deleteFile(launch.gameId, origFile);
        } catch {
          // Best-effort
        }
      }
    }

    if (await ctx.gameFs.fileExists(launch.gameId, ".drop-gse-manifest.json")) {
      await ctx.gameFs.deleteFile(launch.gameId, ".drop-gse-manifest.json").catch(() => {});
    }

    if (await ctx.storage.get<boolean>(PORTABLE_SAVE_STAGED_KEY)) {
      await ctx.gameFs.deleteFile(launch.gameId, PORTABLE_SAVE_CONFIG_FILE).catch(() => {});
      await ctx.storage.delete(PORTABLE_SAVE_STAGED_KEY).catch(() => {});
    }

    for (const file of [
      STEAM_SETTINGS_MAIN_INI,
      STEAM_SETTINGS_APPID_FILE,
      STEAM_SETTINGS_BROADCASTS_FILE,
      STEAM_SETTINGS_INTERFACES_FILE,
      STEAM_SETTINGS_INI,
      STEAM_APPID_FILE,
      CUSTOM_BROADCASTS_FILE,
    ]) {
      await ctx.gameFs.deleteFile(launch.gameId, file).catch(() => {});
    }
    await ctx.storage.delete(ACTIVE_ROOM_KEY).catch(() => {});

    if (room) {
      try {
        await ctx.serverRequest("DELETE", `/rooms/${encodeURIComponent(room.roomId)}`);
      } catch {
        // Room may already be closed
      }

      await this.syncAchievements(ctx, launch, room.appId).catch((err: unknown) => {
        ctx.logger.warn(`GSE achievement sync failed: ${String(err)}`);
      });
    }
  }

  private async readGameText(
    ctx: ClientPluginContext,
    gameId: string,
    relativePath: string,
  ): Promise<string | null> {
    try {
      const bytes = await ctx.gameFs.readFile(gameId, relativePath);
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  /**
   * Parse the emulator's achievements metadata and runtime unlock state, then
   * report ids the platform has not seen yet. Failures are logged and never
   * fail process teardown.
   */
  private async syncAchievements(
    ctx: ClientPluginContext,
    launch: LaunchContext,
    appId: number | undefined,
  ): Promise<void> {
    if (!appId) {
      ctx.logger.debug("No AppID recorded for this room; skipping GSE achievement sync");
      return;
    }

    const definitions = await this.readGameText(ctx, launch.gameId, ACHIEVEMENTS_DEFINITIONS_FILE);
    if (definitions === null) return;

    const configIni = await this.readGameText(ctx, launch.gameId, PORTABLE_SAVE_CONFIG_FILE);
    const configuredPath = configIni ? readLocalSavePath(configIni) : undefined;

    let earnedJson: string | null = null;
    for (const candidate of achievementSaveCandidates(appId, configuredPath)) {
      earnedJson = await this.readGameText(ctx, launch.gameId, candidate);
      if (earnedJson !== null) break;
    }
    if (earnedJson === null) {
      ctx.logger.debug(
        `No portable GSE unlock state for AppID ${appId}; skipping achievement sync`,
      );
      return;
    }

    const knownKey = `${ACHIEVEMENTS_KNOWN_KEY_PREFIX}${launch.gameId}`;
    const known = new Set((await ctx.storage.get<string[]>(knownKey)) ?? []);
    const plan = planAchievementSync(launch.gameId, definitions, earnedJson, known);
    if (plan.requests.length === 0) return;

    const reported: string[] = [];
    for (const request of plan.requests) {
      try {
        await ctx.serverRequest("POST", ACHIEVEMENTS_UNLOCK_PATH, request);
        reported.push(request.key);
      } catch (err) {
        ctx.logger.warn(`Failed to report GSE achievement ${request.key}: ${String(err)}`);
      }
    }

    if (reported.length > 0) {
      await ctx.storage.set(knownKey, [...known, ...reported]);
      ctx.logger.info(`Reported ${reported.length} GSE achievement(s) for "${launch.gameTitle}"`);
    }
  }
}

export const dropGseClientPlugin = new DropGseClientPlugin();

export default dropGseClientPlugin;

/** Game/AppID compatibility registry for GSE rooms. */

/**
 * Known Steam AppIDs with kernel-level or server-authoritative anti-cheat
 * (EasyAntiCheat, BattlEye, Vanguard, VAC, Ricochet, etc.) that cannot run under
 * the Goldberg Steam Emulator.
 */
export const DEFAULT_BLOCKED_APP_IDS: readonly number[] = [
  730, // Counter-Strike 2 (VAC)
  570, // Dota 2 (VAC)
  1172470, // Apex Legends (EasyAntiCheat)
  359550, // Tom Clancy's Rainbow Six Siege (BattlEye)
  578080, // PUBG: BATTLEGROUNDS (BattlEye)
  252490, // Rust (EasyAntiCheat)
  381210, // Dead by Daylight (EasyAntiCheat)
  553850, // HELLDIVERS 2 (nProtect GameGuard)
  1063730, // New World (EasyAntiCheat)
  1805480, // THE FINALS (EasyAntiCheat)
  1938090, // Call of Duty: Warzone / Modern Warfare (Ricochet)
  271590, // Grand Theft Auto V (BattlEye)
  1422450, // Deadlock (VAC)
];

/**
 * Drop game IDs explicitly blocked (e.g. non-Steam anti-cheat titles).
 */
export const DEFAULT_BLOCKED_GAME_IDS: readonly string[] = [
  "valorant",
  "league-of-legends",
  "fortnite",
];

export interface CompatInfo {
  /** Steam AppIDs known to be incompatible with emulator patching. */
  blockedAppIds: number[];
  /** Drop game ids explicitly blocked (e.g. anti-cheat titles). */
  blockedGameIds: string[];
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Read the registry from defaults merged with `GSE_BLOCKED_APP_IDS` / `GSE_BLOCKED_GAME_IDS`. */
export function compatFromEnv(env: NodeJS.ProcessEnv = process.env): CompatInfo {
  const envBlockedAppIds = parseList(env.GSE_BLOCKED_APP_IDS)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
  const envBlockedGameIds = parseList(env.GSE_BLOCKED_GAME_IDS);

  const blockedAppIds = Array.from(new Set([...DEFAULT_BLOCKED_APP_IDS, ...envBlockedAppIds])).sort(
    (a, b) => a - b,
  );
  const blockedGameIds = Array.from(
    new Set([...DEFAULT_BLOCKED_GAME_IDS, ...envBlockedGameIds]),
  ).sort();

  return {
    blockedAppIds,
    blockedGameIds,
  };
}

export class CompatRegistry {
  constructor(private readonly compat: CompatInfo) {}

  isBlocked(gameId: string, appId?: number): boolean {
    if (this.compat.blockedGameIds.includes(gameId)) return true;
    return appId !== undefined && this.compat.blockedAppIds.includes(appId);
  }

  info(): CompatInfo {
    return this.compat;
  }
}

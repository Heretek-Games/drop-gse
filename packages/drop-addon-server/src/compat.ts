/** Game/AppID compatibility registry for GSE rooms. */

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

/** Read the registry from `GSE_BLOCKED_APP_IDS` / `GSE_BLOCKED_GAME_IDS`. */
export function compatFromEnv(env: NodeJS.ProcessEnv = process.env): CompatInfo {
  const blockedAppIds = parseList(env.GSE_BLOCKED_APP_IDS)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
  return {
    blockedAppIds,
    blockedGameIds: parseList(env.GSE_BLOCKED_GAME_IDS),
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

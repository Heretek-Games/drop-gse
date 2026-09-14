/**
 * GSE achievement bridge (#8 / drop-gse).
 *
 * The emulator writes `steam_settings/achievements.json` and records unlocks at
 * runtime. The client addon reads the earned ids and builds requests for the
 * core `POST /api/v1/client/achievements/unlock` endpoint. Parsing and diffing
 * are pure so they are unit-tested without a game install.
 */
export interface GseAchievement {
  key: string;
  name: string;
  hidden: boolean;
}

export interface AchievementUnlockRequest {
  gameId: string;
  key: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function localized(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asString(record.english) ?? asString(Object.values(record)[0]);
  }
  return undefined;
}

function isHidden(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * Parses a Goldberg-family `achievements.json`, accepting an array of entries or
 * an object keyed by achievement id.
 */
export function parseAchievementDefinitions(json: string): GseAchievement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const entries: Array<[string, Record<string, unknown>]> = Array.isArray(parsed)
    ? parsed.map((entry, index) => [String(index), (entry ?? {}) as Record<string, unknown>])
    : Object.entries((parsed ?? {}) as Record<string, Record<string, unknown>>);

  const definitions: GseAchievement[] = [];
  for (const [fallback, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    const key = asString(entry.name) ?? asString(entry.id) ?? (fallback || undefined);
    if (!key) continue;
    definitions.push({
      key,
      name: localized(entry.displayName) ?? key,
      hidden: isHidden(entry.hidden),
    });
  }
  return definitions;
}

/** Builds unlock requests for earned keys not already known to the client. */
export function buildUnlockRequests(
  gameId: string,
  earnedKeys: string[],
  knownKeys: Set<string>,
): AchievementUnlockRequest[] {
  return earnedKeys
    .filter((key) => key.length > 0 && !knownKeys.has(key))
    .map((key) => ({ gameId, key }));
}

function earnedFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return earnedFlag(record.earned) || earnedFlag(record.unlocked) || earnedFlag(record.achieved);
  }
  return false;
}

/**
 * Parses the emulator's runtime unlock state (`<save>/<appId>/achievements.json`).
 * The Goldberg-family format is an object keyed by achievement id whose values
 * carry an `earned` flag (and `earned_time`); array payloads are accepted too.
 */
export function parseEarnedAchievementKeys(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) return earnedKeysFromArray(parsed);
  if (parsed && typeof parsed === "object") {
    return earnedKeysFromObject(parsed as Record<string, unknown>);
  }
  return [];
}

function earnedKeysFromArray(entries: unknown[]): string[] {
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (!earnedFlag(record)) continue;
    const key = asString(record.name) ?? asString(record.id);
    if (key) keys.push(key);
  }
  return keys;
}

function earnedKeysFromObject(map: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(map)) {
    if (key.length > 0 && earnedFlag(entry)) keys.push(key);
  }
  return keys;
}

/**
 * Reads `local_save_path` from a Goldberg-family `configs.user.ini` under the
 * `[user::saves]` section. Returns `undefined` when unset.
 */
export function readLocalSavePath(ini: string): string | undefined {
  let section = "";
  for (const rawLine of ini.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(";") || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    if (section !== "user::saves") continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "local_save_path" && value.length > 0) return value;
  }
  return undefined;
}

export interface AchievementSyncPlan {
  definitions: GseAchievement[];
  requests: AchievementUnlockRequest[];
}

/**
 * Pure composition used by the client post-exit hook: parse the definitions and
 * runtime state, then diff earned ids against the ids already reported.
 */
export function planAchievementSync(
  gameId: string,
  definitionsJson: string,
  earnedJson: string,
  knownKeys: Set<string>,
): AchievementSyncPlan {
  return {
    definitions: parseAchievementDefinitions(definitionsJson),
    requests: buildUnlockRequests(gameId, parseEarnedAchievementKeys(earnedJson), knownKeys),
  };
}

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
    ? parsed.map((entry, index) => [
        String(index),
        (entry ?? {}) as Record<string, unknown>,
      ])
    : Object.entries((parsed ?? {}) as Record<string, Record<string, unknown>>);

  const definitions: GseAchievement[] = [];
  for (const [fallback, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    const key =
      asString(entry.name) ?? asString(entry.id) ?? (fallback || undefined);
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

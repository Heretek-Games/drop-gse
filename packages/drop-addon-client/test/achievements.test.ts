import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnlockRequests,
  parseAchievementDefinitions,
} from "../src/achievements.js";

test("parseAchievementDefinitions reads array and object-map payloads", () => {
  const fromArray = parseAchievementDefinitions(
    JSON.stringify([
      {
        name: "ACH_FIRST",
        displayName: { english: "First Blood" },
        hidden: 0,
      },
      { name: "ACH_SECRET", displayName: "Secret", hidden: 1 },
    ]),
  );
  assert.equal(fromArray.length, 2);
  assert.equal(fromArray[0].key, "ACH_FIRST");
  assert.equal(fromArray[0].name, "First Blood");
  assert.equal(fromArray[1].hidden, true);

  const fromMap = parseAchievementDefinitions(
    JSON.stringify({ ACH_A: { displayName: "A" } }),
  );
  assert.equal(fromMap[0].key, "ACH_A");
});

test("parseAchievementDefinitions tolerates invalid json", () => {
  assert.deepEqual(parseAchievementDefinitions("not json"), []);
});

test("buildUnlockRequests skips already-known achievements", () => {
  const requests = buildUnlockRequests(
    "game-1",
    ["ACH_A", "ACH_B", ""],
    new Set(["ACH_A"]),
  );
  assert.deepEqual(requests, [{ gameId: "game-1", key: "ACH_B" }]);
});

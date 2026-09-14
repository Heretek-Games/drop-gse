import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnlockRequests,
  parseAchievementDefinitions,
  parseEarnedAchievementKeys,
  planAchievementSync,
  readLocalSavePath,
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

  const fromMap = parseAchievementDefinitions(JSON.stringify({ ACH_A: { displayName: "A" } }));
  assert.equal(fromMap[0].key, "ACH_A");
});

test("parseAchievementDefinitions tolerates invalid json", () => {
  assert.deepEqual(parseAchievementDefinitions("not json"), []);
});

test("buildUnlockRequests skips already-known achievements", () => {
  const requests = buildUnlockRequests("game-1", ["ACH_A", "ACH_B", ""], new Set(["ACH_A"]));
  assert.deepEqual(requests, [{ gameId: "game-1", key: "ACH_B" }]);
});

test("parseEarnedAchievementKeys reads earned flags from the save map", () => {
  const keys = parseEarnedAchievementKeys(
    JSON.stringify({
      ACH_A: { earned: true, earned_time: 123 },
      ACH_B: { earned: false, earned_time: 0 },
      ACH_C: true,
      ACH_D: { earned: 1 },
    }),
  );
  assert.deepEqual(keys, ["ACH_A", "ACH_C", "ACH_D"]);
});

test("parseEarnedAchievementKeys tolerates invalid json and arrays", () => {
  assert.deepEqual(parseEarnedAchievementKeys("not json"), []);
  assert.deepEqual(
    parseEarnedAchievementKeys(
      JSON.stringify([
        { name: "ACH_A", earned: true },
        { name: "ACH_B", earned: false },
      ]),
    ),
    ["ACH_A"],
  );
});

test("readLocalSavePath only reads local_save_path under [user::saves]", () => {
  const ini = [
    "; portable saves",
    "[user::saves]",
    "local_save_path = gse_saves",
    "",
    "[main::connectivity]",
    "listen_port=47584",
  ].join("\n");
  assert.equal(readLocalSavePath(ini), "gse_saves");
  assert.equal(readLocalSavePath("[main::connectivity]\nlisten_port=47584"), undefined);
});

test("planAchievementSync parses definitions and diffs earned ids", () => {
  const plan = planAchievementSync(
    "42",
    JSON.stringify([{ name: "ACH_A" }, { name: "ACH_B" }]),
    JSON.stringify({ ACH_A: { earned: true }, ACH_B: { earned: true } }),
    new Set(["ACH_A"]),
  );
  assert.equal(plan.definitions.length, 2);
  assert.deepEqual(plan.requests, [{ gameId: "42", key: "ACH_B" }]);
});

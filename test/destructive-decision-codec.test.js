"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  decodeDestructiveDecisionInfo,
} = require("../consumers/postgres-migrations/dist/src/authoring-contract.js");

function invalid(pathValue, reason) {
  return {
    ok: false,
    problems: [{
      field: null,
      messageKey: "test.invalid",
      severity: "blocking",
      details: {path: pathValue, reason},
    }],
  };
}

const validMigrate = {
  changeId: "change-1",
  source: {side: "from", entity: "Account", field: "legacy"},
  partitionCheck: {name: "partition-ok", kind: "check", contentHash: "a".repeat(64)},
  resolution: {kind: "migrate", dataMigrationId: "move-account", outputs: ["id", "email"]},
};
const migrated = decodeDestructiveDecisionInfo(validMigrate, "decision", invalid);
assert.equal(migrated.ok, true);
assert.deepEqual(migrated.value, validMigrate);

const discarded = decodeDestructiveDecisionInfo({
  changeId: "change-2",
  source: null,
  partitionCheck: null,
  resolution: {kind: "discard", reason: "obsolete data"},
}, "decision", invalid);
assert.equal(discarded.ok, true);

const duplicate = decodeDestructiveDecisionInfo({
  ...validMigrate,
  resolution: {...validMigrate.resolution, outputs: ["id", "id"]},
}, "decision", invalid);
assert.equal(duplicate.ok, false);
assert.equal(duplicate.problems[0].details.path, 'decision["resolution"]["outputs"][1]');
assert.equal(duplicate.problems[0].details.reason, "migrate outputs must be unique");

const emptyOutputs = decodeDestructiveDecisionInfo({
  ...validMigrate,
  resolution: {...validMigrate.resolution, outputs: []},
}, "decision", invalid);
assert.equal(emptyOutputs.ok, false);
assert.equal(emptyOutputs.problems[0].details.reason, "migrate outputs must contain at least one output");

const wrongPartitionKind = decodeDestructiveDecisionInfo({
  ...validMigrate,
  partitionCheck: {name: "step", kind: "sql", contentHash: "b".repeat(64)},
}, "decision", invalid);
assert.equal(wrongPartitionKind.ok, false);
assert.equal(wrongPartitionKind.problems[0].details.reason, "partitionCheck must reference a check resource");

for (const relative of [
  "consumers/postgres-migrations/src/preparation-artifact.ts",
  "consumers/postgres-migrations/src/resolve-conflict.ts",
]) {
  const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  assert.doesNotMatch(source, /function decodeDecision\s*\(/, `${relative} must not re-own destructive decision membership`);
  assert.match(source, /decodeDestructiveDecisionInfo\(/, `${relative} must delegate destructive decision membership`);
}

console.log("destructive decision codec tests passed");

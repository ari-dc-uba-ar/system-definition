"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  decodeDataDecisionInfo,
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

const checked = {
  changeId: "change-3", source: null, partitionCheck: null,
  resolution: {kind: "check", run: {kind: "check", name: "values-valid", contentHash: "c".repeat(64)}},
};
assert.deepEqual(decodeDataDecisionInfo(checked, "decision", invalid), {ok: true, value: checked});
assert.equal(decodeDestructiveDecisionInfo(checked, "decision", invalid).ok, false, "a check must never become destructive approval");
assert.deepEqual(decodeDataDecisionInfo(validMigrate, "decision", invalid), migrated);

console.log("destructive decision codec tests passed");

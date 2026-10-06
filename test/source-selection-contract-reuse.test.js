const assert = require("node:assert/strict");
const {buildSourceSelection} = require("../.verify-dist/consumers/postgres-migrations/src/source-selection.js");

const hash = "a".repeat(64);
const context = {
    from: {entities: {users: {fields: {id: {type: "id", nullable: false}}}}},
};
const def = () => ({
    queryName: "users-source",
    schema: "public",
    base: {entity: "users", alias: "u"},
    joins: [],
    ports: {id: {alias: "u", field: "id"}},
    identity: ["id"],
    coverageChecks: [],
});

let input = def();
input.coverageChecks = [{name: "coverage", kind: "check", contentHash: hash}];
let result = buildSourceSelection(context, input);
assert.equal(result.ok, true);
assert.deepEqual(result.value.selection.coverageChecks, input.coverageChecks);

input = def();
input.coverageChecks = [{name: "coverage", kind: "check", contentHash: "bad"}];
result = buildSourceSelection(context, input);
assert.equal(result.ok, false);
assert.equal(result.problems[0].messageKey, "migration.authoringInvalid");
assert.equal(result.problems[0].details.reason, "invalid coverage check");

input = def();
input.coverageChecks = [{name: "coverage", kind: "sql", contentHash: hash}];
result = buildSourceSelection(context, input);
assert.equal(result.ok, false);
assert.equal(result.problems[0].details.reason, "invalid coverage check");

// The frozen duplicate only required length > 0. The package-owned ResourceRefInfo
// contract is non-blank, so one exported type now has one runtime membership rule.
input = def();
input.coverageChecks = [{name: "   ", kind: "check", contentHash: hash}];
result = buildSourceSelection(context, input);
assert.equal(result.ok, false);
assert.equal(result.problems[0].details.reason, "invalid coverage check");

input = def();
input.coverageChecks = [
    {name: "coverage", kind: "check", contentHash: hash},
    {name: "coverage", kind: "check", contentHash: hash},
];
result = buildSourceSelection(context, input);
assert.equal(result.ok, false);
assert.equal(result.problems[0].details.reason, "duplicate coverage check");

console.log("source selection contract reuse tests passed");

const assert = require("node:assert/strict");
const {decodeFileInfo} = require("../dist/src/common/migration.js");
const {decodeProblem} = require("../dist/src/common/problem.js");

const invalid = (path, reason) => ({
    ok: false,
    problems: [{field: null, messageKey: "boundary.contractInvalid", severity: "blocking", details: {path, reason}}],
});

const file = decodeFileInfo({
    path: "migrations/001.sql",
    contentHash: "a".repeat(64),
    byteLength: 42,
}, "$.entry", invalid);
assert.deepEqual(file, {
    ok: true,
    value: {path: "migrations/001.sql", contentHash: "a".repeat(64), byteLength: 42},
});

// Frozen consumer decoders required a non-empty path, not a trimmed/non-blank path.
const whitespacePath = decodeFileInfo({
    path: "   ",
    contentHash: "a".repeat(64),
    byteLength: 0,
}, "$.entry", invalid);
assert.equal(whitespacePath.ok, true);

const negativeLength = decodeFileInfo({
    path: "migrations/001.sql",
    contentHash: "a".repeat(64),
    byteLength: -1,
}, "$.entry", invalid);
assert.equal(negativeLength.ok, false);
assert.deepEqual(negativeLength.problems[0].details, {
    path: '$.entry["byteLength"]',
    reason: "file byteLength must be a non-negative safe integer",
});

const problem = decodeProblem({
    field: null,
    messageKey: "migration.invalidReference",
    severity: "blocking",
    details: {reason: "missing"},
}, "$.problems[0]", invalid);
assert.equal(problem.ok, true);
assert.deepEqual({...problem.value.details}, {reason: "missing"});

// Problem historically required messageKey.length > 0, not trim().length > 0.
const whitespaceMessageKey = decodeProblem({
    field: "field",
    messageKey: " ",
    severity: "regular",
    details: {},
}, "$.problems[0]", invalid);
assert.equal(whitespaceMessageKey.ok, true);

const badDetail = decodeProblem({
    field: null,
    messageKey: "migration.invalidReference",
    severity: "blocking",
    details: {count: 2},
}, "$.problems[0]", invalid);
assert.equal(badDetail.ok, false);
assert.deepEqual(badDetail.problems[0].details, {
    path: '$.problems[0]["details"]["count"]',
    reason: "problem detail must be a string",
});

console.log("package contract codec tests passed");

const assert = require("node:assert/strict");
const {decodeReleaseRefInfo, decodeResourceRefInfo} = require("../dist/src/common/migration.js");

const invalid = (path, reason) => ({
    ok: false,
    problems: [{field: null, messageKey: "boundary.contractInvalid", severity: "blocking", details: {path, reason}}],
});

const release = decodeReleaseRefInfo({
    systemId: "system",
    releaseId: "r1",
    releaseHash: "1".repeat(64),
}, "$", invalid);
assert.deepEqual(release, {ok: true, value: {systemId: "system", releaseId: "r1", releaseHash: "1".repeat(64)}});

const blankRelease = decodeReleaseRefInfo({
    systemId: "   ",
    releaseId: "r1",
    releaseHash: "1".repeat(64),
}, "$", invalid);
assert.equal(blankRelease.ok, false);
assert.deepEqual(blankRelease.problems[0].details, {
    path: '$["systemId"]',
    reason: "systemId must not be empty",
});

const badRelease = decodeReleaseRefInfo({
    systemId: "system",
    releaseId: "r1",
    releaseHash: "NOT-A-HASH",
}, "$", invalid);
assert.equal(badRelease.ok, false);
assert.equal(badRelease.problems[0].messageKey, "boundary.contractInvalid");
assert.deepEqual(badRelease.problems[0].details, {
    path: '$["releaseHash"]',
    reason: "releaseHash must be a lowercase SHA-256 hex digest",
});

const resource = decodeResourceRefInfo({
    name: "check-users",
    kind: "check",
    contentHash: "a".repeat(64),
}, "$.resource", invalid);
assert.deepEqual(resource, {ok: true, value: {name: "check-users", kind: "check", contentHash: "a".repeat(64)}});

const extra = decodeResourceRefInfo({
    name: "check-users",
    kind: "check",
    contentHash: "a".repeat(64),
    extra: true,
}, "$.resource", invalid);
assert.equal(extra.ok, false);
assert.deepEqual(extra.problems[0].details, {path: '$.resource["extra"]', reason: "unexpected property"});

console.log("migration contract codec tests passed");

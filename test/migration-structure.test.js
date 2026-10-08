const assert = require("node:assert/strict");
const {completeMigration, decodeMigration} = require("../dist/src/common/migration.js");

const releaseHash1 = "1".repeat(64);
const releaseHash2 = "2".repeat(64);
const sqlHash = "a".repeat(64);
const checkHash = "b".repeat(64);
const context = {
    releases: {
        one: {systemId: "system", releaseId: "r1", releaseHash: releaseHash1},
        two: {systemId: "system", releaseId: "r2", releaseHash: releaseHash2},
    },
    resources: {
        run: {kind: "sql", file: {path: "run.sql", contentHash: sqlHash, byteLength: 1}},
        check: {kind: "check", file: {path: "check.sql", contentHash: checkHash, byteLength: 1}},
    },
};

const completed = completeMigration(context, {
    id: "m1",
    from: "one",
    to: "two",
    description: "migration",
    before: ["check"],
    steps: [{id: "s1", run: "run"}],
});
assert.equal(completed.ok, true);
assert.equal(completed.value.after.length, 0);

const unexpected = completeMigration(context, {
    id: "m1",
    from: "one",
    to: "two",
    steps: [],
    extra: true,
});
assert.equal(unexpected.ok, false);
assert.equal(unexpected.problems[0].messageKey, "migration.invalidJson");
assert.deepEqual(unexpected.problems[0].details, {path: '$["extra"]', reason: "unexpected property"});

const decoded = decodeMigration({
    id: "m1",
    from: context.releases.one,
    to: context.releases.two,
    description: "migration",
    before: [],
    steps: [{id: "s1", run: {name: "run", kind: "sql", contentHash: sqlHash}}],
    after: [],
}, context);
assert.equal(decoded.ok, true);

console.log("migration structural reuse tests passed");

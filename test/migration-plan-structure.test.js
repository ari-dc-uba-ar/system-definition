const assert = require("node:assert/strict");
const {completeMigrationCatalog, resolveMigrationPath} = require("../.verify-dist/migration-plan.js");

const h1 = "1".repeat(64);
const h2 = "2".repeat(64);
const mh = "a".repeat(64);
const releases = [
    {systemId: "system", releaseId: "r1", releaseHash: h1},
    {systemId: "system", releaseId: "r2", releaseHash: h2},
];
const migration = {
    id: "m1",
    from: releases[0],
    to: releases[1],
    description: "",
    before: [],
    steps: [],
    after: [],
};

const catalog = completeMigrationCatalog(releases, [{migration, migrationHash: mh}]);
assert.equal(catalog.ok, true);
assert.equal(catalog.value.systemId, "system");
assert.equal(resolveMigrationPath(catalog.value, "r1", "r2").ok, true);

const extraRelease = completeMigrationCatalog([
    {systemId: "system", releaseId: "r1", releaseHash: h1, extra: true},
], []);
assert.equal(extraRelease.ok, false);
assert.equal(extraRelease.problems[0].messageKey, "migration.invalidCatalog");
assert.deepEqual(extraRelease.problems[0].details, {
    path: '$["releases"][0]["extra"]',
    reason: "unexpected property",
});

const badStep = completeMigrationCatalog(releases, [{
    migration: {...migration, steps: [{id: "s1", run: {name: "run", kind: "sql", contentHash: mh}, extra: 1}]},
    migrationHash: mh,
}]);
assert.equal(badStep.ok, false);
assert.deepEqual(badStep.problems[0].details, {
    path: '$["migrations"][0]["migration"]["steps"][0]["extra"]',
    reason: "unexpected property",
});

console.log("migration-plan structural reuse tests passed");

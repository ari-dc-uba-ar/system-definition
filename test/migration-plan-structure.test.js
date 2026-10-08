const assert = require("node:assert/strict");
const {completeMigrationCatalog, resolveMigrationPath} = require("../dist/src/common/migration-plan.js");

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

const {decodeMigrationPathInfo} = require("../dist/src/common/migration-plan.js");
const invalid = (path, reason) => ({ok: false, problems: [{path, reason}]});
const path = {from: releases[0], to: releases[1], migrations: [{migration, migrationHash: mh}]};
const decodedPath = decodeMigrationPathInfo(path, "$", invalid);
assert.equal(decodedPath.ok, true);
assert.deepEqual(decodedPath.value, path);

const brokenPath = {
    from: releases[0],
    to: releases[1],
    migrations: [{migration: {...migration, from: releases[1]}, migrationHash: mh}],
};
const broken = decodeMigrationPathInfo(brokenPath, "$", invalid);
assert.equal(broken.ok, false);
assert.equal(broken.problems[0].reason, "migration path is not contiguous");

const incompleteMigration = {
    from: releases[0],
    to: releases[1],
    migrations: [{migration: {id: "m1", from: releases[0], to: releases[1]}, migrationHash: mh}],
};
assert.equal(decodeMigrationPathInfo(incompleteMigration, "$", invalid).ok, false);

const blankTarget = {...path, to: {...releases[1], releaseId: "   "}};
assert.equal(decodeMigrationPathInfo(blankTarget, "$", invalid).ok, false);

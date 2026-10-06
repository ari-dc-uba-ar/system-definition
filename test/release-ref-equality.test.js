const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {sameReleaseRef} = require("../.verify-dist/src/common/migration.js");

const base = {systemId: "system", releaseId: "r1", releaseHash: "a".repeat(64)};
assert.equal(sameReleaseRef(base, {...base}), true);
assert.equal(sameReleaseRef(base, {...base, systemId: "other"}), false);
assert.equal(sameReleaseRef(base, {...base, releaseId: "r2"}), false);
assert.equal(sameReleaseRef(base, {...base, releaseHash: "b".repeat(64)}), false);

for (const relative of [
    "consumers/postgres-migrations/src/journal-internal.ts",
    "consumers/postgres-migrations/src/recovery.ts",
    "consumers/postgres-migrations/src/deployment-gate.ts",
    "consumers/postgres-migrations/src/evidence.ts",
    "consumers/postgres-migrations/src/resolve-conflict.ts",
]) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.doesNotMatch(
        source,
        /left\.systemId === right\.systemId[\s\S]{0,120}left\.releaseId === right\.releaseId[\s\S]{0,120}left\.releaseHash === right\.releaseHash/,
        `${relative} must not re-own ReleaseRefInfo equality`,
    );
}

const evidence = fs.readFileSync(
    path.join(__dirname, "../consumers/postgres-migrations/src/evidence.ts"),
    "utf8",
);
assert.match(evidence, /function sameOptionalRelease/);
assert.match(evidence, /return sameReleaseRef\(left, right\)/);

const resolver = fs.readFileSync(
    path.join(__dirname, "../consumers/postgres-migrations/src/resolve-conflict.ts"),
    "utf8",
);
assert.match(resolver, /function sameOptionalRelease/);
assert.match(resolver, /return sameReleaseRef\(left, right\)/);

console.log("release reference equality tests passed");

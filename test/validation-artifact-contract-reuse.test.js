const assert = require("node:assert/strict");
const {decodeValidationArtifact} = require("../.verify-dist/consumers/postgres-migrations/src/validation-artifact.js");

const hash = "a".repeat(64);
const valid = () => ({
    formatVersion: 1,
    side: "from",
    snapshotHash: hash,
    entry: {path: "validators.mjs", contentHash: hash, byteLength: 12},
    runtime: {nodeVersion: "22.0.0", abi: "migration-validation-1"},
    domainContractHashes: {},
    entityValidatorNames: {},
});

const ok = decodeValidationArtifact(valid());
assert.equal(ok.ok, true);
assert.deepEqual(ok.value.entry, {path: "validators.mjs", contentHash: hash, byteLength: 12});

const cases = [
    [artifact => { artifact.entry.extra = true; }, "invalid entry shape"],
    [artifact => { artifact.entry.path = ""; }, "invalid entry path"],
    [artifact => { artifact.entry.contentHash = "bad"; }, "invalid entry content hash"],
    [artifact => { artifact.entry.byteLength = -1; }, "invalid entry byte length"],
    [artifact => { artifact.extra = true; }, "invalid artifact shape"],
];
for (const [mutate, reason] of cases) {
    const artifact = valid();
    mutate(artifact);
    const decoded = decodeValidationArtifact(artifact);
    assert.equal(decoded.ok, false);
    assert.equal(decoded.problems[0].messageKey, "migration.validationArtifactInvalid");
    assert.equal(decoded.problems[0].details.reason, reason);
}

const badDomainHash = valid();
badDomainHash.domainContractHashes.users = "bad";
const badMap = decodeValidationArtifact(badDomainHash);
assert.equal(badMap.ok, false);
assert.equal(badMap.problems[0].details.reason, "invalid domain contract hashes entry");
assert.equal(badMap.problems[0].details.name, "users");

console.log("validation artifact contract reuse tests passed");

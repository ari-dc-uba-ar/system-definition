const assert = require("node:assert/strict");
const {isPgNonEmptyText} = require("../.verify-dist/consumers/postgres-migrations/src/pg-text.js");
const {recordVerification} = require("../.verify-dist/consumers/postgres-migrations/src/evidence.js");

assert.equal(isPgNonEmptyText("ok"), true);
assert.equal(isPgNonEmptyText(""), false);
assert.equal(isPgNonEmptyText("bad\0text"), false);

const hash = "c".repeat(64);
const binding = () => ({
    deploymentId: "dep-1",
    installationId: "inst-1",
    candidateApplicationHash: hash,
    planHash: hash,
    operation: "install",
    from: null,
    to: {systemId: "system", releaseId: "r1", releaseHash: hash},
    engineVersion: "18.6",
    schemas: ["public"],
    configurationHash: hash,
    maintenanceId: "maint-1",
    production: false,
});
const run = () => ({
    verificationId: "verify-1",
    binding: binding(),
    checks: [],
    createdAt: "2026-10-06T00:00:00Z",
});
function session() {
    const state = {calls: 0};
    return {
        state,
        async query() { state.calls++; return {rows: []}; },
        async close() {},
    };
}

(async () => {
    let db = session();
    let result = await recordVerification(db, {schema: "bad\0schema"}, run());
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].messageKey, "migration.invalidJournal");
    assert.equal(db.state.calls, 0);

    db = session();
    const nulDeployment = run();
    nulDeployment.binding.deploymentId = "dep\0id";
    result = await recordVerification(db, {schema: "journal"}, nulDeployment);
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid deployment binding");
    assert.equal(db.state.calls, 0);

    db = session();
    const nulRelease = run();
    nulRelease.binding.to.systemId = "sys\0tem";
    result = await recordVerification(db, {schema: "journal"}, nulRelease);
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid release reference");
    assert.equal(db.state.calls, 0);

    db = session();
    const nulProblem = run();
    nulProblem.checks = [{
        id: "artifacts",
        kind: "artifacts",
        status: "failed",
        reportId: "report-1",
        problems: [{field: null, messageKey: "bad\0key", severity: "blocking", details: {}}],
    }];
    result = await recordVerification(db, {schema: "journal"}, nulProblem);
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid verification problem");
    assert.equal(db.state.calls, 0);

    db = session();
    result = await recordVerification(db, {schema: "journal"}, run());
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "verification insert did not return exactly one row");
    assert.equal(db.state.calls, 1);

    console.log("evidence PostgreSQL refinement tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

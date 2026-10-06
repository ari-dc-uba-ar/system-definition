const assert = require("node:assert/strict");
const {
    finishAttempt,
    installBaseline,
    startAttempt,
    readConfirmedPreparation,
    readHistory,
} = require("../.verify-dist/consumers/postgres-migrations/src/journal.js");

const hash = "b".repeat(64);

function noQuerySession() {
    const state = {calls: 0};
    return {
        state,
        async query() {
            state.calls++;
            throw new Error("query should not run");
        },
        async close() {},
    };
}

function rowSession(row) {
    const state = {calls: 0};
    return {
        state,
        async query() {
            state.calls++;
            return {rows: [row], rowCount: 1};
        },
        async close() {},
    };
}

const validScope = {systemId: "system", schemas: ["app"]};
const validBaseline = {systemId: "system", releaseId: "r1", releaseHash: hash};

(async () => {
    // PostgreSQL-owned text refinement survives package-codec delegation.
    let db = noQuerySession();
    let result;

    // Exact-key mechanics come from the shared path-aware structural owner;
    // journal only maps those failures to its existing boundary reasons.
    db = noQuerySession();
    result = await readHistory(db, {schema: "journal", extra: true}, "installation-1");
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid journal schema");
    assert.equal(db.state.calls, 0);

    db = noQuerySession();
    result = await installBaseline(db, {schema: "journal"}, {
        installationId: "installation-1",
        scope: validScope,
        baseline: validBaseline,
        extra: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid baseline installation input");
    assert.equal(db.state.calls, 0);

    db = noQuerySession();
    result = await readHistory(db, {schema: "bad\0schema"}, "installation-1");
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].messageKey, "migration.invalidJournal");
    assert.equal(result.problems[0].details.reason, "invalid journal schema");
    assert.equal(db.state.calls, 0);

    db = noQuerySession();
    result = await readHistory(db, {schema: "journal"}, "installation\0id");
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].messageKey, "migration.invalidJournal");
    assert.equal(result.problems[0].details.reason, "invalid installation id");
    assert.equal(db.state.calls, 0);

    db = noQuerySession();
    result = await installBaseline(db, {schema: "journal"}, {
        installationId: "installation-1",
        scope: validScope,
        baseline: {...validBaseline, releaseId: "r\0one"},
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid release reference");
    assert.equal(db.state.calls, 0);

    // ReleaseRefInfo has one intrinsic runtime contract now. The frozen journal
    // accepted whitespace-only ids; the package owner intentionally rejects them.
    db = noQuerySession();
    result = await installBaseline(db, {schema: "journal"}, {
        installationId: "installation-1",
        scope: validScope,
        baseline: {...validBaseline, releaseId: "   "},
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid release reference");
    assert.equal(db.state.calls, 0);

    db = rowSession({
        attempt_id: "attempt-1",
        deployment_id: "deployment-1",
        installation_id: "installation-1",
        plan_hash: hash,
        state: "running",
        confirmed_target_system_id: null,
        confirmed_target_release_id: null,
        confirmed_target_release_hash: null,
        problems: [],
        extra: true,
    });
    result = await startAttempt(db, {schema: "journal"}, {
        attemptId: "attempt-1",
        deploymentId: "deployment-1",
        installationId: "installation-1",
        planHash: hash,
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid execution attempt row");
    assert.equal(db.state.calls, 1);

    // Problem decoding delegates intrinsic shape/details to the package codec,
    // while journal keeps its existing outward reason buckets and NUL refinement.
    db = noQuerySession();
    result = await finishAttempt(db, {schema: "journal"}, "attempt-1", {
        state: "failed",
        confirmedTarget: null,
        problems: [{field: null, messageKey: "bad\0key", severity: "blocking", details: {}}],
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid attempt problem");
    assert.equal(db.state.calls, 0);

    db = noQuerySession();
    result = await finishAttempt(db, {schema: "journal"}, "attempt-1", {
        state: "failed",
        confirmedTarget: null,
        problems: [{field: null, messageKey: "migration.example", severity: "blocking", details: {count: 2}}],
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "problem details must be strings");
    assert.equal(db.state.calls, 0);

    // Preparation-history release refs use the same package-owned release contract.
    db = rowSession({
        installation_id: "installation-1",
        ordinal: 1,
        preparation_id: "prep-1",
        artifact_hash: hash,
        head_system_id: "system",
        head_release_id: "   ",
        head_release_hash: hash,
        before_fingerprint: hash,
        after_fingerprint: hash,
        report_hash: hash,
        committed_at: "2026-10-06T00:00:00Z",
    });
    result = await readConfirmedPreparation(db, {schema: "journal"}, "installation-1", "prep-1");
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "invalid release reference");
    assert.equal(db.state.calls, 1);

    console.log("journal package-contract/refinement tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

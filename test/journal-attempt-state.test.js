const assert = require("node:assert/strict");
const {
    ATTEMPT_STATE,
    ATTEMPT_STATES,
    bootstrapJournal,
    finishAttempt,
    startAttempt,
    startPreparationAttempt,
} = require("../.verify-dist/consumers/postgres-migrations/src/journal.js");

const hash = "a".repeat(64);

function session(handler) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({text, values});
            return handler ? handler(text, values, calls.length) : {rows: [], rowCount: null};
        },
        async close() {},
    };
}

(async () => {
    assert.deepEqual(ATTEMPT_STATES, ["running", "failed", "unknown", "succeeded"]);
    assert.equal(ATTEMPT_STATE.running, ATTEMPT_STATES[0]);
    assert.equal(ATTEMPT_STATE.failed, ATTEMPT_STATES[1]);
    assert.equal(ATTEMPT_STATE.unknown, ATTEMPT_STATES[2]);
    assert.equal(ATTEMPT_STATE.succeeded, ATTEMPT_STATES[3]);

    const ddlSession = session();
    const bootstrapped = await bootstrapJournal(ddlSession, {schema: "journal"});
    assert.equal(bootstrapped.ok, true);
    const stateSql = ATTEMPT_STATES.map(state => `'${state}'`).join(",");
    const executionDdl = ddlSession.calls.find(call => call.text.includes("CREATE TABLE IF NOT EXISTS \"journal\".execution_attempt"));
    const preparationDdl = ddlSession.calls.find(call => call.text.includes("CREATE TABLE IF NOT EXISTS \"journal\".preparation_attempts"));
    assert.ok(executionDdl);
    assert.ok(preparationDdl);
    assert.ok(executionDdl.text.includes(`CHECK (state IN (${stateSql}))`));
    assert.ok(preparationDdl.text.includes(`CHECK (state IN (${stateSql}))`));

    const runningRow = {
        attempt_id: "attempt-1",
        deployment_id: "deployment-1",
        installation_id: "installation-1",
        plan_hash: hash,
        state: ATTEMPT_STATE.running,
        confirmed_target_system_id: null,
        confirmed_target_release_id: null,
        confirmed_target_release_hash: null,
        problems: [],
    };
    const startSession = session(async () => ({rows: [runningRow], rowCount: 1}));
    const started = await startAttempt(startSession, {schema: "journal"}, {
        attemptId: "attempt-1",
        deploymentId: "deployment-1",
        installationId: "installation-1",
        planHash: hash,
    });
    assert.equal(started.ok, true);
    assert.equal(started.value.state, ATTEMPT_STATE.running);
    assert.match(startSession.calls[0].text, /VALUES \(\$1,\$2,\$3,\$4,'running'/);

    const invalidStateSession = session(async () => ({rows: [{...runningRow, state: "ready"}], rowCount: 1}));
    const invalidState = await startAttempt(invalidStateSession, {schema: "journal"}, {
        attemptId: "attempt-1",
        deploymentId: "deployment-1",
        installationId: "installation-1",
        planHash: hash,
    });
    assert.equal(invalidState.ok, false);
    assert.equal(invalidState.problems[0].messageKey, "migration.invalidJournal");
    assert.equal(invalidState.problems[0].details.reason, "invalid execution attempt row");

    const finishSession = session(() => { throw new Error("finish query should not run"); });
    const runningFinish = await finishAttempt(finishSession, {schema: "journal"}, "attempt-1", {
        state: ATTEMPT_STATE.running,
        confirmedTarget: null,
        problems: [],
    });
    assert.equal(runningFinish.ok, false);
    assert.equal(runningFinish.problems[0].details.reason, "invalid attempt finish input");
    assert.equal(finishSession.calls.length, 0);

    const preparationRow = {
        attempt_id: "prep-attempt-1",
        installation_id: "installation-1",
        preparation_id: "prep-1",
        artifact_hash: hash,
        state: ATTEMPT_STATE.running,
        before_fingerprint: hash,
        after_fingerprint: null,
        report_hash: hash,
        problems: [],
    };
    const preparationSession = session(async () => ({rows: [preparationRow], rowCount: 1}));
    const preparation = await startPreparationAttempt(preparationSession, {schema: "journal"}, {
        attemptId: "prep-attempt-1",
        installationId: "installation-1",
        preparationId: "prep-1",
        artifactHash: hash,
        beforeFingerprint: hash,
        reportHash: hash,
    });
    assert.equal(preparation.ok, true);
    assert.equal(preparation.value.state, ATTEMPT_STATE.running);
    assert.match(preparationSession.calls[0].text, /VALUES \(\$1,\$2,\$3,\$4,'running'/);

    console.log("journal attempt-state SSOT tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

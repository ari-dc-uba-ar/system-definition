const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    readAttempt,
    settleAttempt,
} = require("../consumers/postgres-migrations/dist/src/journal.js");

const hash = "c".repeat(64);
const target = {systemId: "system", releaseId: "r2", releaseHash: hash};

function row(state, confirmedTarget = null) {
    return {
        attempt_id: "attempt-1",
        deployment_id: "deployment-1",
        installation_id: "installation-1",
        plan_hash: hash,
        state,
        confirmed_target_system_id: confirmedTarget?.systemId ?? null,
        confirmed_target_release_id: confirmedTarget?.releaseId ?? null,
        confirmed_target_release_hash: confirmedTarget?.releaseHash ?? null,
        problems: [],
    };
}

function session(handler) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({text, values});
            return handler(text, values, calls.length);
        },
        async close() {},
    };
}

(async () => {
    let db = session(async () => ({rows: [row("unknown")], rowCount: 1}));
    let result = await readAttempt(db, {schema: "journal"}, "attempt-1");
    assert.equal(result.ok, true);
    assert.equal(result.value.state, "unknown");
    assert.match(db.calls[0].text, /FROM "journal"\.execution_attempt/);

    db = session(async (text) => {
        assert.match(text, /state IN \('running','unknown'\)/);
        return {rows: [row("succeeded", target)], rowCount: 1};
    });
    result = await settleAttempt(db, {schema: "journal"}, "attempt-1", {
        state: "succeeded",
        confirmedTarget: target,
        problems: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.state, "succeeded");
    assert.deepEqual(result.value.confirmedTarget, target);
    assert.equal(db.calls.length, 1);

    db = session(async (_text, _values, call) => call === 1
        ? {rows: [], rowCount: 0}
        : {rows: [row("succeeded", target)], rowCount: 1});
    result = await settleAttempt(db, {schema: "journal"}, "attempt-1", {
        state: "succeeded",
        confirmedTarget: target,
        problems: [],
    });
    assert.equal(result.ok, true);
    assert.equal(db.calls.length, 2);

    db = session(async (_text, _values, call) => call === 1
        ? {rows: [], rowCount: 0}
        : {rows: [row("failed")], rowCount: 1});
    result = await settleAttempt(db, {schema: "journal"}, "attempt-1", {
        state: "succeeded",
        confirmedTarget: target,
        problems: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].details.reason, "attempt terminal state disagrees with durable migration outcome");

    const recoverySource = fs.readFileSync(
        path.join(__dirname, "../consumers/postgres-migrations/src/recovery.ts"),
        "utf8",
    );
    assert.doesNotMatch(recoverySource, /execution_attempt/);
    assert.doesNotMatch(recoverySource, /function decodeAttemptRow/);
    assert.doesNotMatch(recoverySource, /function attemptSelect/);
    assert.match(recoverySource, /readAttempt/);
    assert.match(recoverySource, /settleAttempt/);

    console.log("recovery attempt ownership tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

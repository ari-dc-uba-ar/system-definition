const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {readLatestAttempt} = require("../consumers/postgres-migrations/dist/src/journal.js");

const hash = "d".repeat(64);
const target = {systemId: "system", releaseId: "r2", releaseHash: hash};

function attemptRow(overrides = {}) {
    return {
        attempt_id: "attempt-1",
        deployment_id: "deployment-1",
        installation_id: "installation-1",
        plan_hash: hash,
        state: "succeeded",
        confirmed_target_system_id: target.systemId,
        confirmed_target_release_id: target.releaseId,
        confirmed_target_release_hash: target.releaseHash,
        problems: [],
        ...overrides,
    };
}

function session(rows) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({text, values});
            return {rows, rowCount: rows.length};
        },
        async close() {},
    };
}

(async () => {
    let db = session([attemptRow()]);
    let result = await readLatestAttempt(db, {schema: "journal"}, "deployment-1", "installation-1", hash);
    assert.equal(result.ok, true);
    assert.equal(result.value.attemptId, "attempt-1");
    assert.equal(result.value.state, "succeeded");
    assert.deepEqual(result.value.confirmedTarget, target);
    assert.match(db.calls[0].text, /FROM "journal"\.execution_attempt/);
    assert.match(db.calls[0].text, /ORDER BY a\.started_at DESC/);
    assert.match(db.calls[0].text, /LIMIT 1/);

    db = session([]);
    result = await readLatestAttempt(db, {schema: "journal"}, "deployment-1", "installation-1", hash);
    assert.equal(result.ok, true);
    assert.equal(result.value, null);

    db = session([attemptRow({deployment_id: "other"})]);
    result = await readLatestAttempt(db, {schema: "journal"}, "deployment-1", "installation-1", hash);
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].messageKey, "migration.invalidJournal");
    assert.equal(result.problems[0].details.reason, "execution attempt does not match lookup");

    const gateSource = fs.readFileSync(
        path.join(__dirname, "../consumers/postgres-migrations/src/deployment-gate.ts"),
        "utf8",
    );
    assert.doesNotMatch(gateSource, /execution_attempt/);
    assert.doesNotMatch(gateSource, /function decodeAttempt/);
    assert.doesNotMatch(gateSource, /type AttemptRow/);
    assert.match(gateSource, /readLatestAttempt/);

    console.log("deployment attempt ownership tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

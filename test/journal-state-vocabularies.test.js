"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    DEPLOYMENT_READINESS_STATE,
    DEPLOYMENT_READINESS_STATES,
    VERIFICATION_STATUS,
    VERIFICATION_STATUSES,
} = require("../consumers/postgres-migrations/dist/src/journal-contracts.js");
const {bootstrapJournal} = require("../consumers/postgres-migrations/dist/src/journal-schema.js");

assert.deepEqual(VERIFICATION_STATUSES, ["passed", "failed", "incomplete"]);
assert.deepEqual(DEPLOYMENT_READINESS_STATES, ["pending", "blocked", "ready", "consumed"]);
assert.equal(VERIFICATION_STATUS.passed, VERIFICATION_STATUSES[0]);
assert.equal(DEPLOYMENT_READINESS_STATE.ready, DEPLOYMENT_READINESS_STATES[2]);

(async () => {
    const statements = [];
    const bootstrapped = await bootstrapJournal({
        query: async text => {
            statements.push(text);
            return {rows: [], rowCount: null};
        },
        close: async () => {},
    }, {schema: "journal"});
    assert.equal(bootstrapped.ok, true);

    const ddl = statements.join("\n");
    const verificationSql = VERIFICATION_STATUSES.map(value => `'${value}'`).join(",");
    const readinessSql = DEPLOYMENT_READINESS_STATES.map(value => `'${value}'`).join(",");
    assert.match(ddl, new RegExp(`status IN \\(${verificationSql}\\)`));
    assert.match(ddl, new RegExp(`state IN \\(${readinessSql}\\)`));

    const root = path.resolve(__dirname, "..");
    const evidence = fs.readFileSync(path.join(root, "consumers/postgres-migrations/src/evidence.ts"), "utf8");
    const gate = fs.readFileSync(path.join(root, "consumers/postgres-migrations/src/deployment-gate.ts"), "utf8");
    const schema = fs.readFileSync(path.join(root, "consumers/postgres-migrations/src/journal-schema.ts"), "utf8");
    assert.equal(evidence.includes('["passed", "failed", "incomplete"]'), false);
    assert.equal(gate.includes('"pending" | "blocked" | "ready" | "consumed"'), false);
    assert.equal(schema.includes("status IN ('passed','failed','incomplete')"), false);
    assert.equal(schema.includes("state IN ('pending','blocked','ready','consumed')"), false);

    console.log("journal state vocabulary tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const {POSTGRES_SUPPORT, matchesPostgresSupport} = require("../consumers/postgres-migrations/dist/src/postgres-support.js");
const {checkPostgres18_6} = require("../consumers/postgres-migrations/dist/src/pg-schema.js");

assert.deepEqual(POSTGRES_SUPPORT, {
    engine: "postgresql",
    version: "18.6",
    serverVersionNum: 180006,
});
assert.equal(matchesPostgresSupport(POSTGRES_SUPPORT), true);
assert.equal(matchesPostgresSupport({...POSTGRES_SUPPORT, version: "18.7"}), false);

for (const relative of [
    "consumers/postgres-migrations/src/artifact.ts",
    "consumers/postgres-migrations/src/pg-schema.ts",
    "consumers/postgres-migrations/src/evidence.ts",
    "consumers/postgres-migrations/src/inspect-schema.ts",
    "consumers/postgres-migrations/src/compare-schema.ts",
]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.equal(source.includes('"18.6"'), false, `${relative} must derive the supported version`);
    assert.equal(source.includes("180006"), false, `${relative} must derive server_version_num`);
    assert.equal(source.includes('"postgresql"'), false, `${relative} must derive the engine`);
}

(async () => {
    const ok = await checkPostgres18_6({
        query: async () => ({rows: [{server_version_num: "180006"}], rowCount: 1}),
        close: async () => {},
    });
    assert.deepEqual(ok, {ok: true, value: {serverVersionNum: POSTGRES_SUPPORT.serverVersionNum}});

    const mismatch = await checkPostgres18_6({
        query: async () => ({rows: [{server_version_num: "180007"}], rowCount: 1}),
        close: async () => {},
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.problems[0].details.expected, String(POSTGRES_SUPPORT.serverVersionNum));

    console.log("PostgreSQL support SSOT tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

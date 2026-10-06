"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    comparePgIdentity,
    pgIdentityKey,
    samePgIdentity,
} = require("../.verify-dist/consumers/postgres-migrations/src/pg-identity.js");

const table = {schema: "app", kind: "table", name: "user", parentName: null, signature: []};
const sameTable = {...table, signature: []};
const column = {schema: "app", kind: "column", name: "id", parentName: "user", signature: []};
const routineA = {schema: "app", kind: "routine", name: "f", parentName: null, signature: ["int4"]};
const routineB = {schema: "app", kind: "routine", name: "f", parentName: null, signature: ["text"]};

assert.equal(pgIdentityKey(table), JSON.stringify(["app", "table", null, "user", []]));
assert.equal(samePgIdentity(table, sameTable), true);
assert.equal(samePgIdentity(table, column), false);
assert.equal(samePgIdentity(routineA, routineB), false);
assert.equal(comparePgIdentity(table, sameTable), 0);
const routineAKey = pgIdentityKey(routineA);
const routineBKey = pgIdentityKey(routineB);
const expectedOrder = routineAKey < routineBKey ? -1 : routineAKey > routineBKey ? 1 : 0;
assert.equal(comparePgIdentity(routineA, routineB), expectedOrder);

const root = path.resolve(__dirname, "..");
for (const relative of [
    "consumers/postgres-migrations/src/inspect-schema.ts",
    "consumers/postgres-migrations/src/compare-schema.ts",
]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.equal(source.includes("function identityKey"), false, `${relative} must not own identity keys`);
    assert.equal(source.includes("function sameIdentity"), false, `${relative} must not own identity equality`);
    assert.equal(source.includes("function compareIdentity"), false, `${relative} must not own identity ordering`);
}

console.log("PostgreSQL identity tests passed");

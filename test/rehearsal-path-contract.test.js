const fs = require("node:fs");
const assert = require("node:assert/strict");

const source = fs.readFileSync("consumers/postgres-migrations/src/rehearsal.ts", "utf8");
const start = source.indexOf("function validPath(");
const end = source.indexOf("function validInput(", start);
const adapter = source.slice(start, end);
assert.match(adapter, /decodeMigrationPathInfo\(/);
assert.equal(adapter.includes("migrationHash"), false, "rehearsal must not re-own published migration membership");
assert.equal(adapter.includes("for (const entry"), false, "rehearsal must not re-own path traversal");
assert.match(source, /decodeReleaseRefInfo\(/);
assert.equal(source.includes("function hash(value"), false, "rehearsal must use package hash-bearing contracts");

console.log("rehearsal path contract tests passed");

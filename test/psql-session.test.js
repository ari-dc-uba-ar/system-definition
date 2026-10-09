const fs = require("node:fs");
const assert = require("node:assert/strict");
const {
    bindSql,
    parseCsvLine,
    parsePgArray,
    rowsFromCsv,
    sqlLiteral,
} = require("../consumers/postgres-migrations/scripts/lib/psql-session.js");

assert.equal(sqlLiteral(null), "NULL");
assert.equal(sqlLiteral(true), "TRUE");
assert.equal(sqlLiteral(42), "42");
assert.equal(sqlLiteral("O'Reilly"), "'O''Reilly'");
assert.equal(sqlLiteral(Uint8Array.from([0, 255])), "decode('00ff', 'hex')");
assert.throws(() => sqlLiteral(Number.POSITIVE_INFINITY), /non-finite/);
assert.throws(() => bindSql("select $2", ["only-one"]), /missing SQL parameter \$2/);
assert.equal(bindSql("select $1, $2", ["x", 3]), "select 'x', 3");

assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
assert.deepEqual(parsePgArray("{}"), []);
assert.deepEqual(parsePgArray('{a,"b,c",NULL}'), ["a", "b,c", null]);

const seen = [];
const rows = rowsFromCsv([
    "BEGIN",
    "name,count,optional",
    "alice,2,__SD_NULL__",
], (column, raw) => {
    seen.push([column, raw]);
    return column === "count" ? Number(raw) : raw;
});
assert.equal(Object.getPrototypeOf(rows[0]), null);
assert.deepEqual(Object.assign({}, rows[0]), {name: "alice", count: 2, optional: null});
assert.deepEqual(seen, [["name", "alice"], ["count", "2"]], "null handling stays in transport");

const librarySource = fs.readFileSync("consumers/postgres-migrations/scripts/lib/psql-session.js", "utf8");
for (const domainColumn of ["binding", "checks", "locked", "unlocked", "journal_format_version"]) {
    assert.equal(librarySource.includes(`"${domainColumn}"`), false, `transport must not own ${domainColumn} coercion`);
}
assert.match(librarySource, /:SQLSTATE/);
assert.doesNotMatch(librarySource, /ON_ERROR_STOP/);

const authoringSource = fs.readFileSync("consumers/postgres-migrations/scripts/test-authoring-integration.js", "utf8");
assert.match(authoringSource, /createPostgresScratch/);
assert.doesNotMatch(authoringSource, /class PsqlSession/);
assert.doesNotMatch(authoringSource, /require\("node:child_process"\)/);
assert.match(authoringSource, /studentProject/);
const driverSource = fs.readFileSync("consumers/postgres-migrations/src/pg-session.ts", "utf8");
assert.match(driverSource, /from "pg"/);
assert.match(driverSource, /client\.query/);
assert.equal(authoringSource.includes('"locked"'), false, "authoring coercion must not inherit conflict-only columns");

const conflictSource = fs.readFileSync("consumers/postgres-migrations/scripts/test-conflict-resolution-integration.js", "utf8");
assert.match(conflictSource, /require\("\.\/lib\/psql-session\.js"\)/);
assert.doesNotMatch(conflictSource, /class PsqlSession/);
assert.doesNotMatch(conflictSource, /require\("node:child_process"\)/);
assert.match(conflictSource, /new PsqlSession\(\{decodeValue: typedValue\}\)/);
assert.match(conflictSource, /"locked", "unlocked"/);
assert.match(conflictSource, /simulated ambiguous commit after server COMMIT/);
assert.equal(librarySource.includes("simulated ambiguous commit"), false, "scenario failure injection stays outside transport");

console.log("shared psql session transport tests passed");

const assert = require("node:assert/strict");
const {
    decodeContentRefInfo,
    decodeFileResourceInfo,
} = require("../dist/src/common/migration.js");

const HASH = "a".repeat(64);
const invalid = (path, reason) => ({ok: false, problems: [{path, reason}]});

{
    const decoded = decodeContentRefInfo(
        {name: "select_users", kind: "query", contentHash: HASH},
        "$",
        "query",
        invalid,
    );
    assert.deepEqual(decoded, {
        ok: true,
        value: {name: "select_users", kind: "query", contentHash: HASH},
    });
}

{
    const decoded = decodeContentRefInfo(
        {name: "select_users", kind: "check", contentHash: HASH},
        "$",
        "query",
        invalid,
    );
    assert.equal(decoded.ok, false);
    assert.equal(decoded.problems[0].path, '$["kind"]');
}

{
    const decoded = decodeFileResourceInfo(
        {kind: "query", file: {path: "queries/users.sql", contentHash: HASH, byteLength: 12}},
        "$",
        "query",
        invalid,
    );
    assert.deepEqual(decoded, {
        ok: true,
        value: {
            kind: "query",
            file: {path: "queries/users.sql", contentHash: HASH, byteLength: 12},
        },
    });
}

{
    const decoded = decodeFileResourceInfo(
        {kind: "query", file: {path: "queries/users.sql", contentHash: HASH, byteLength: -1}},
        "$",
        "query",
        invalid,
    );
    assert.equal(decoded.ok, false);
    assert.equal(decoded.problems[0].path, '$["file"]["byteLength"]');
}

console.log("generic content contract codec tests passed");

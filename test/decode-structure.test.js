const assert = require("node:assert/strict");
const {childPath, exactKeys, isPlainObject} = require("../.verify-dist/decode-structure.js");

assert.equal(childPath("$", 'a"b'), '$["a\\\"b"]');
assert.equal(isPlainObject({}), true);
assert.equal(isPlainObject(Object.create(null)), true);
assert.equal(isPlainObject([]), false);
assert.equal(isPlainObject(new (class Example {})()), false);

const invalid = (path, reason) => ({
    ok: false,
    problems: [{field: null, messageKey: "migration.unsupportedFormat", severity: "blocking", details: {path, reason}}],
});

const extra = exactKeys({entities: [], representations: {}, extra: true}, ["entities", "representations"], "$", invalid);
assert.equal(extra.ok, false);
assert.deepEqual(extra.problems[0].details, {path: '$["extra"]', reason: "unexpected property"});
assert.equal(extra.problems[0].messageKey, "migration.unsupportedFormat");

const missing = exactKeys({entities: []}, ["entities", "representations"], "$", invalid);
assert.equal(missing.ok, false);
assert.deepEqual(missing.problems[0].details, {path: '$["representations"]', reason: "missing property"});

assert.deepEqual(exactKeys({entities: [], representations: {}}, ["entities", "representations"], "$", invalid), {ok: true, value: true});
console.log("decode-structure tests passed");

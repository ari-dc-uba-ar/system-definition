const assert = require("node:assert/strict");
const {childPath, exactKeys, exactOptionalKeys, isNonBlankString, isPlainObject, isSha256} = require("../.verify-dist/decode-structure.js");

assert.equal(childPath("$", 'a"b'), '$["a\\\"b"]');
assert.equal(isPlainObject({}), true);
assert.equal(isPlainObject(Object.create(null)), true);
assert.equal(isPlainObject([]), false);
assert.equal(isPlainObject(new (class Example {})()), false);
assert.equal(isNonBlankString("value"), true);
assert.equal(isNonBlankString("   "), false);
assert.equal(isSha256("a".repeat(64)), true);
assert.equal(isSha256("A".repeat(64)), false);

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
const optionalOk = exactOptionalKeys(
    {id: "m1", from: "r1", to: "r2", steps: [], description: "optional"},
    ["id", "from", "to", "steps"],
    ["description", "before", "after"],
    "$",
    invalid,
);
assert.deepEqual(optionalOk, {ok: true, value: true});

const optionalMissing = exactOptionalKeys(
    {id: "m1", from: "r1", steps: []},
    ["id", "from", "to", "steps"],
    ["description", "before", "after"],
    "$",
    invalid,
);
assert.equal(optionalMissing.ok, false);
assert.deepEqual(optionalMissing.problems[0].details, {path: '$["to"]', reason: "missing property"});

const optionalExtra = exactOptionalKeys(
    {id: "m1", from: "r1", to: "r2", steps: [], extra: true},
    ["id", "from", "to", "steps"],
    ["description", "before", "after"],
    "$",
    invalid,
);
assert.equal(optionalExtra.ok, false);
assert.deepEqual(optionalExtra.problems[0].details, {path: '$["extra"]', reason: "unexpected property"});

console.log("decode-structure tests passed");

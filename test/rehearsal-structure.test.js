"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("consumers/postgres-migrations/src/rehearsal.ts", "utf8");

assert.doesNotMatch(source, /function isObject\s*\(/, "rehearsal must not re-own structural object membership");
assert.doesNotMatch(source, /function exactKeys\s*\(/, "rehearsal must not re-own exact-key mechanics");
assert.doesNotMatch(source, /function nonEmpty\s*\(/, "rehearsal must not re-own non-empty string membership");
assert.match(source, /function hasExactShape[\s\S]*isPlainObject\(value\)[\s\S]*exactKeys\(/,
  "record-shaped rehearsal inputs must delegate to the shared structural owner");
assert.match(source, /function validSession[\s\S]*Reflect\.get\(value, "query"\)/,
  "session capability checks must not require a plain-record prototype");
assert.match(source, /function validProvider[\s\S]*Reflect\.get\(value, "open"\)/,
  "provider capability checks must remain behavioral rather than structural");

console.log("rehearsal structural reuse tests passed");

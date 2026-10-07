"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../consumers/postgres-migrations/src/resolve-conflict.ts"),
  "utf8",
);

assert.doesNotMatch(source, /function isObject\s*\(/, "resolver must not re-own plain-object membership");
assert.doesNotMatch(source, /function exactKeys\s*\(/, "resolver must not re-own exact-key mechanics");
assert.doesNotMatch(source, /function nonEmptyString\s*\(/, "resolver must not re-own non-empty string membership");
assert.doesNotMatch(source, /const HASH_RE\s*=/, "resolver must not re-own SHA-256 membership");
assert.match(source, /\bexactKeys\(/, "resolver must delegate shape mechanics");
assert.match(source, /\bisPlainObject\(/, "resolver must delegate object membership");
assert.match(source, /\bisNonEmptyString\(/, "resolver must delegate string membership");
assert.match(source, /\bisSha256\(/, "resolver must delegate SHA-256 membership");

console.log("resolve-conflict structural reuse tests passed");

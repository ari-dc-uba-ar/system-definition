"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("consumers/postgres-migrations/src/preparation-artifact.ts", "utf8");

assert.match(source, /return isPlainObject\(value\);/,
  "preparation artifact object membership must use the shared strict plain-object owner");
assert.match(source, /function hasExactShape[\s\S]*structuralExactKeys\(/,
  "preparation artifact exact-shape checks must delegate to the shared structural owner");
assert.doesNotMatch(source, /const HASH_RE\s*=/,
  "preparation artifact must not own SHA-256 membership");
assert.doesNotMatch(source, /function nonEmpty\s*\(/,
  "preparation artifact must not own non-empty-string membership");
assert.doesNotMatch(source, /function hash\s*\(/,
  "preparation artifact must not own SHA-256 membership through a wrapper");
assert.match(source, /\bisNonEmptyString\(/,
  "preparation artifact must delegate non-empty strings");
assert.match(source, /\bisSha256\(/,
  "preparation artifact must delegate SHA-256 membership");

console.log("preparation artifact structural reuse tests passed");

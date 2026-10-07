"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("consumers/postgres-migrations/src/migration-authoring.ts", "utf8");

assert.match(source, /return isPlainObject\(value\);/,
  "authoring object membership must delegate to the shared strict plain-object owner");
assert.match(source, /return exactOptionalKeys\(value, required, optional, path, invalid\);/,
  "authoring exact-shape mechanics must delegate while preserving boundary diagnostics");
assert.match(source, /if \(!isNonEmptyString\(value\)\)/,
  "authoring non-empty string membership must delegate to the shared primitive");
assert.doesNotMatch(source, /Object\.keys\(value\).*unexpected property/s,
  "authoring must not reimplement exact-key traversal");
assert.doesNotMatch(source, /typeof value !== "string" \|\| value\.length === 0/,
  "authoring must not reimplement non-empty string membership");

console.log("migration-authoring structural reuse tests passed");

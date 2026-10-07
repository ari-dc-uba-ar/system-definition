"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("consumers/postgres-migrations/src/recovery.ts", "utf8");

assert.doesNotMatch(source, /const HASH_RE\s*=/,
  "recovery must not own SHA-256 membership");
assert.doesNotMatch(source, /function hashString\s*\(/,
  "recovery must not own a hash codec");
assert.doesNotMatch(source, /function decodeReleaseParts\s*\(/,
  "recovery must not reconstruct release-reference membership");
assert.match(source, /decodePublishedMigrationInfo\(/,
  "recovery must delegate PublishedMigrationInfo membership to the package contract");
assert.match(source, /\bisPgNonEmptyText\(attemptId\)/,
  "recovery must preserve PostgreSQL text refinement for persisted identifiers");
assert.match(source, /isPgNonEmptyText\(from\.systemId\)/,
  "recovery must preserve PostgreSQL text refinement after neutral contract decoding");

console.log("recovery package-contract reuse tests passed");

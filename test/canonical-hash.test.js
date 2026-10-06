"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const {canonicalJsonSha256, omitJsonObjectKeys} = require("../.verify-dist/consumers/postgres-migrations/src/canonical-hash.js");
const {canonicalJson} = require("../.verify-dist/src/common/json-value.js");

const value = {z: 1, a: {b: true}, selfHash: "ignored"};
const omitted = omitJsonObjectKeys(value, ["selfHash"]);
assert.deepEqual({...omitted}, {z: 1, a: {b: true}});
const expected = crypto.createHash("sha256").update(canonicalJson(omitted), "utf8").digest("hex");
assert.equal(canonicalJsonSha256(omitted), expected);
assert.throws(() => omitJsonObjectKeys([], ["x"]), /strict JSON object/);

for (const file of [
  "artifact.ts",
  "conflict-report.ts",
  "preparation-artifact.ts",
  "preparation-history.ts",
  "validation-artifact.ts",
  "resolve-conflict.ts",
]) {
  const source = fs.readFileSync(`consumers/postgres-migrations/src/${file}`, "utf8");
  assert.equal(/createHash\("sha256"\)\.update\(canonicalJson\(/.test(source), false, `${file} must delegate canonical JSON hashing`);
}
console.log("canonical JSON hashing tests passed");

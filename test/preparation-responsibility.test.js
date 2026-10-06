const fs = require("node:fs");
const assert = require("node:assert/strict");

const artifact = fs.readFileSync("consumers/postgres-migrations/src/preparation-artifact.ts", "utf8");
const orchestration = fs.readFileSync("consumers/postgres-migrations/src/preparation.ts", "utf8");
const errorOwner = fs.readFileSync("consumers/postgres-migrations/src/preparation-error.ts", "utf8");

assert.match(artifact, /export type PreparationArtifactInfo/);
assert.match(artifact, /export function decodePreparationArtifact/);
assert.match(artifact, /export function createPreparationArtifact/);
assert.match(artifact, /export function computePreparationArtifactHash/);
assert.match(artifact, /function validateClosure/);

assert.match(orchestration, /export \* from "\.\/preparation-artifact"/);
assert.match(errorOwner, /migration\.invalidPreparation/);
assert.equal(artifact.includes("migration.invalidPreparation"), false);
assert.equal(orchestration.includes("migration.invalidPreparation"), false);
for (const implementation of [
  "function decodePreparation(",
  "function validateClosure(",
  "function hashableArtifact(",
  "function decodeDecision(",
  "function decodeSourceSelection(",
]) {
  assert.equal(orchestration.includes(implementation), false, `${implementation} must be artifact-owned`);
}

console.log("preparation responsibility tests passed");

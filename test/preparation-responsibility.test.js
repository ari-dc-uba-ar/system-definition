const fs = require("node:fs");
const assert = require("node:assert/strict");

const artifact = fs.readFileSync("consumers/postgres-migrations/src/preparation-artifact.ts", "utf8");
const orchestration = fs.readFileSync("consumers/postgres-migrations/src/preparation.ts", "utf8");
const preflight = fs.readFileSync("consumers/postgres-migrations/src/preparation-preflight.ts", "utf8");
const history = fs.readFileSync("consumers/postgres-migrations/src/preparation-history.ts", "utf8");
const execution = fs.readFileSync("consumers/postgres-migrations/src/preparation-execution.ts", "utf8");
const errorOwner = fs.readFileSync("consumers/postgres-migrations/src/preparation-error.ts", "utf8");

assert.match(artifact, /export type PreparationArtifactInfo/);
assert.match(artifact, /export function decodePreparationArtifact/);
assert.match(artifact, /export function createPreparationArtifact/);
assert.match(artifact, /export function computePreparationArtifactHash/);
assert.match(artifact, /function validateClosure/);

assert.match(orchestration, /export \* from "\.\/preparation-artifact"/);
assert.match(preflight, /export function checkPreparationPreconditions/);
assert.match(preflight, /export function checkCurrentPreparationPreconditions/);
assert.equal(orchestration.includes("function checkPreparationPreconditions("), false);
assert.equal(orchestration.includes("function checkCurrentPreparationPreconditions("), false);
assert.match(history, /export function computePreparationHistoryHash/);
assert.match(history, /export async function readPreparationHistoryHash/);
assert.equal(orchestration.includes("function computePreparationHistoryHash("), false);
assert.equal(orchestration.includes("function preparationHistoryEntries("), false);
assert.match(execution, /export async function verifyResolution/);
assert.match(execution, /export async function applyResolution/);
assert.match(execution, /export const preparationReceiptStatus/);
assert.equal(orchestration.includes("function validReceipt("), false);
assert.equal(orchestration.includes("executeMigrationPreparation"), false);
assert.equal(orchestration.split("\n").filter(Boolean).length <= 8, true, "preparation.ts should be a facade only");
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

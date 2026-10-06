const fs = require("node:fs");
const assert = require("node:assert/strict");
const {
  recordVerificationRecord,
  readLatestVerificationRecord,
} = require("../.verify-dist/consumers/postgres-migrations/src/journal-verification.js");

const status = "passed";
const createdAt = "2026-10-06T12:00:00Z";
const binding = {deploymentId: "deploy-1", marker: "binding"};
const checks = [{id: "check-1"}];

let recordedSql = "";
let recordedValues = null;
const recordSession = {
  query: async (text, values) => {
    recordedSql = text;
    recordedValues = values;
    return {
      rows: [{
        verification_id: "verify-1",
        ordinal: 1,
        deployment_id: "deploy-1",
        binding,
        status,
        checks,
        created_at: createdAt,
      }],
      rowCount: 1,
    };
  },
};

(async () => {
  const stored = await recordVerificationRecord(recordSession, {schema: "journal"}, {
    verificationId: "verify-1",
    deploymentId: "deploy-1",
    binding,
    status,
    checks,
    createdAt,
  });
  assert.equal(stored.ok, true);
  assert.equal(stored.value.ordinal, 1);
  assert.match(recordedSql, /"journal"\.verification_run/);
  assert.equal(recordedValues[2], JSON.stringify(binding));
  assert.equal(recordedValues[4], JSON.stringify(checks));

  let readSql = "";
  const readSession = {
    query: async (text) => {
      readSql = text;
      return {
        rows: [{
          verification_id: "verify-1",
          ordinal: 2,
          deployment_id: "deploy-1",
          binding,
          status,
          checks,
          created_at: createdAt,
        }],
        rowCount: 1,
      };
    },
  };
  const latest = await readLatestVerificationRecord(readSession, {schema: "journal"}, "deploy-1");
  assert.equal(latest.ok, true);
  assert.equal(latest.value.ordinal, 2);
  assert.match(readSql, /ORDER BY v\.ordinal DESC/);

  const badSession = {
    query: async () => ({
      rows: [{
        verification_id: "verify-1",
        ordinal: 1,
        deployment_id: "deploy-1",
        binding,
        status: "bogus",
        checks,
        created_at: createdAt,
      }],
      rowCount: 1,
    }),
  };
  const bad = await readLatestVerificationRecord(badSession, {schema: "journal"}, "deploy-1");
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].messageKey, "migration.invalidJournal");

  const evidenceSource = fs.readFileSync("consumers/postgres-migrations/src/evidence.ts", "utf8");
  assert.equal(evidenceSource.includes("verification_run"), false, "evidence must not own the durable verification table");
  assert.equal(evidenceSource.includes("verification_id"), false, "evidence must not own verification row columns");
  assert.equal(evidenceSource.includes("async function safeQuery("), false, "evidence must use journal persistence operations");

  const journalSource = fs.readFileSync("consumers/postgres-migrations/src/journal-verification.ts", "utf8");
  assert.match(journalSource, /verification_run/);
  assert.match(journalSource, /function decodeVerificationRow/);

  console.log("verification journal ownership tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

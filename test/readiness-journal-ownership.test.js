const fs = require("node:fs");
const assert = require("node:assert/strict");
const {
  upsertDeploymentReadiness,
  consumeDeploymentReadiness,
} = require("../.verify-dist/consumers/postgres-migrations/src/journal-readiness.js");

const hash = "a".repeat(64);
const binding = {deploymentId: "deploy-1", planHash: hash};
const target = {systemId: "system", releaseId: "release", releaseHash: hash};

(async () => {
  let upsertSql = "";
  let upsertValues = null;
  const upsertSession = {
    query: async (text, values) => {
      upsertSql = text;
      upsertValues = values;
      return {rows: [], rowCount: 1};
    },
  };
  const stored = await upsertDeploymentReadiness(upsertSession, {schema: "journal"}, {
    deploymentId: "deploy-1",
    installationId: "installation-1",
    binding,
    state: "ready",
    verificationId: "verification-1",
    applyAttemptId: "attempt-1",
    confirmedTarget: target,
    problems: [],
  });
  assert.equal(stored.ok, true);
  assert.match(upsertSql, /"journal"\.deployment_readiness/);
  assert.match(upsertSql, /ON CONFLICT \(deployment_id\)/);
  assert.equal(upsertValues[2], JSON.stringify(binding));
  assert.equal(upsertValues[3], "ready");

  let consumeSql = "";
  const consumeSession = {
    query: async (text, values) => {
      consumeSql = text;
      assert.equal(values[5], "consumed");
      assert.equal(values[6], "ready");
      return {rows: [], rowCount: 1};
    },
  };
  const consumed = await consumeDeploymentReadiness(consumeSession, {schema: "journal"}, {
    deploymentId: "deploy-1",
    installationId: "installation-1",
    verificationId: "verification-1",
    applyAttemptId: "attempt-1",
    binding,
  });
  assert.equal(consumed.ok, true);
  assert.match(consumeSql, /deployment_readiness/);
  assert.match(consumeSql, /state = \$6/);

  const missingSession = {query: async () => ({rows: [], rowCount: 0})};
  const missing = await consumeDeploymentReadiness(missingSession, {schema: "journal"}, {
    deploymentId: "deploy-1",
    installationId: "installation-1",
    verificationId: "verification-1",
    applyAttemptId: "attempt-1",
    binding,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].messageKey, "migration.invalidJournal");
  assert.equal(missing.problems[0].details.reason, "ready deployment could not be consumed exactly once");

  const gateSource = fs.readFileSync("consumers/postgres-migrations/src/deployment-gate.ts", "utf8");
  assert.equal(gateSource.includes("deployment_readiness"), false, "deployment policy must not own the durable readiness table");
  assert.equal(gateSource.includes("async function safeQuery("), false, "deployment policy must use journal persistence operations");
  assert.equal(gateSource.includes("confirmed_target_system_id"), false, "deployment policy must not own readiness row columns");

  const journalSource = fs.readFileSync("consumers/postgres-migrations/src/journal-readiness.ts", "utf8");
  assert.match(journalSource, /deployment_readiness/);
  assert.match(journalSource, /confirmed_target_system_id/);

  console.log("readiness journal ownership tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

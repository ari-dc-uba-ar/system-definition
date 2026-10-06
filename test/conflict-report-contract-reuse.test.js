const assert = require("node:assert/strict");
const {createConflictReport, decodeConflictReport} = require("../.verify-dist/consumers/postgres-migrations/src/conflict-report.js");

const hash = "b".repeat(64);
const release = {systemId: "system", releaseId: "r1", releaseHash: hash};
const draft = () => ({
    formatVersion: 1,
    reportId: "report-1",
    command: "prepare",
    kind: "authoringDecision",
    phase: "authoring",
    systemId: "system",
    draftHash: null,
    installationId: null,
    attemptId: null,
    confirmedHead: release,
    requestedTarget: {...release, releaseId: "r2"},
    planHash: null,
    observedSchemaHash: null,
    historyHash: null,
    questions: [],
    problems: [],
    evidenceRefs: [],
});

const created = createConflictReport(draft());
assert.equal(created.ok, true);
assert.equal(decodeConflictReport(created.value).ok, true);

const badFileDraft = draft();
badFileDraft.evidenceRefs = [{path: "evidence.json", contentHash: "bad", byteLength: 1}];
const badFile = createConflictReport(badFileDraft);
assert.equal(badFile.ok, false);
assert.equal(badFile.problems[0].messageKey, "migration.invalidConflictReport");
assert.equal(badFile.problems[0].details.reason, "invalid evidence file reference");

const badProblemDraft = draft();
badProblemDraft.problems = [{
    field: null,
    messageKey: "migration.example",
    severity: "blocking",
    details: {count: 2},
}];
const badProblem = createConflictReport(badProblemDraft);
assert.equal(badProblem.ok, false);
assert.equal(badProblem.problems[0].details.reason, "problem details must be strings");

// Frozen FileInfo/Problem consumers used length > 0 rather than trim().length > 0.
const preservedNonEmpty = draft();
preservedNonEmpty.evidenceRefs = [{path: " ", contentHash: hash, byteLength: 0}];
preservedNonEmpty.problems = [{field: null, messageKey: " ", severity: "regular", details: {}}];
assert.equal(createConflictReport(preservedNonEmpty).ok, true);

// The duplicate conflict-report release codec used to accept this, while the package
// ReleaseRefInfo codec rejected it. One type now has one canonical runtime contract.
const blankRelease = draft();
blankRelease.confirmedHead = {...release, systemId: "   "};
const canonicalRelease = createConflictReport(blankRelease);
assert.equal(canonicalRelease.ok, false);
assert.equal(canonicalRelease.problems[0].details.reason, "invalid confirmed head");

const extra = created.value;
const withExtra = {...extra, unexpected: true};
const badShape = decodeConflictReport(withExtra);
assert.equal(badShape.ok, false);
assert.equal(badShape.problems[0].details.reason, "invalid conflict report shape");

console.log("conflict report contract reuse tests passed");

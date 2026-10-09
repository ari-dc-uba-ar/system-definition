"use strict";
// These scenarios compile the public, commented examples. No hand-built migration SQL and
// no excluded application objects can make a broken generator appear to pass this suite.
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const {
    compileDraft, compiledArtifact, createPostgresScratch, buildReleaseOnScratch, inspectSchema,
    bootstrapJournal, installBaseline, resolveMigrationExecutionContext, executeMigrationPath, buildMigrationPlan,
    readInstallation, checkDeploymentReady, recordVerification, checkApplyEligibility,
} = require("../dist/src/index.js");
const {studentProject} = require("../../../examples/postgres-migrations/dist/student-runtime.js");
const {legacyRelease, currentRelease} = require("../../../examples/postgres-migrations/dist/student-migrations.js");
const {textHash} = require("../../../examples/postgres-migrations/dist/support.js");

function value(result) { assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.problems)); return result.value; }
async function inspected(session, release) {
    const result = value(await inspectSchema(session, release.inspection));
    assert.deepEqual(result.unknown, []);
    assert.deepEqual(result.excluded, []);
    return result.schema;
}

async function lateFailure(compiled, files) {
    const scratch = createPostgresScratch({}, ["app"]);
    const source = value(await scratch.create("upgrade-source"));
    const target = value(await scratch.create("clean-target"));
    try {
        value(await buildReleaseOnScratch(source.session, legacyRelease));
        value(await buildReleaseOnScratch(target.session, currentRelease));
        const fromSchema = await inspected(source.session, legacyRelease);
        const toSchema = await inspected(target.session, currentRelease);
        const journal = {schema: "authoring_test_journal"};
        const scope = {systemId: "students", schemas: ["app"]};
        value(await bootstrapJournal(source.session, journal));
        value(await installBaseline(source.session, journal, {installationId: source.id, scope, baseline: legacyRelease.ref}));
        await source.session.query('INSERT INTO app.students ("studentId", name, "legacyEmail", "legacyNote") VALUES (1, $1, $2, $3)', ["Student", "original@example.org", "Keep until commit"]);
        const text = "SELECT false AS ok;\n";
        const ref = {name: "intentional-late-failure", kind: "check", contentHash: textHash(text)};
        value(await files.emitResource({ref, text}));
        const rejected = {...compiled, migration: {...compiled.migration, after: [ref]}};
        const artifact = compiledArtifact(rejected, files, {from: legacyRelease.snapshot, to: currentRelease.snapshot});
        const resources = Object.fromEntries([...files.resources].filter(([, resource]) => resource.ref.kind !== "query"));
        const context = value(await resolveMigrationExecutionContext(artifact.published, {
            journal, scope, resources,
            from: {expectedSchema: fromSchema, inspection: legacyRelease.inspection, managedData: [], invariantChecks: []},
            to: {expectedSchema: toSchema, inspection: currentRelease.inspection, managedData: [], invariantChecks: []},
            options: {statementTimeoutMs: 30000, lockTimeoutMs: 5000}, now: () => new Date().toISOString(),
        }, artifact.runtime));
        const path = {from: legacyRelease.ref, to: currentRelease.ref, migrations: [artifact.published]};
        const plan = value(await buildMigrationPlan(path, artifact.runtime));
        const execution = await executeMigrationPath(source.session, path, () => ({ok: true, value: context}));
        assert.equal(execution.ok, false, "late check must abort after data writes and drops");
        assert.deepEqual(await inspected(source.session, legacyRelease), fromSchema, "all DDL rolled back");
        const rows = await source.session.query('SELECT "legacyEmail", "legacyNote" FROM app.students', []);
        assert.deepEqual(rows.rows, [{legacyEmail: "original@example.org", legacyNote: "Keep until commit"}], "all data preserved");
        assert.deepEqual(value(await readInstallation(source.session, journal, scope)).current, legacyRelease.ref);
        const binding = {deploymentId: randomUUID(), installationId: source.id, candidateApplicationHash: textHash("candidate"),
            planHash: plan.planHash, operation: "upgrade", from: legacyRelease.ref, to: currentRelease.ref,
            engineVersion: "18.6", schemas: ["app"], configurationHash: textHash("configuration"), maintenanceId: "maintenance", production: false};
        // A failed run supersedes any previous success and blocks both entry points.
        value(await recordVerification(source.session, journal, {verificationId: randomUUID(), binding,
            createdAt: new Date().toISOString(), checks: [{id: "rollback-check", kind: "structure", status: "failed", reportId: randomUUID(), problems: execution.problems}]}));
        assert.equal((await checkApplyEligibility(binding, {session: source.session, journal})).ok, false);
        let activations = 0;
        const gate = await checkDeploymentReady(binding, {session: source.session, journal,
            maintenance: {async isActive() { return true; }}, async finalChecks() { return {ok: true, value: true}; }});
        if (gate.ok) activations++;
        assert.equal(gate.ok, false);
        assert.equal(activations, 0);
    } finally {
        value(await scratch.destroy(source));
        value(await scratch.destroy(target));
    }
}

async function main() {
    for (const kind of ["inferred", "data", "manual", "destructive"]) {
        const project = await studentProject(kind);
        const {draft, runtime, files} = project.authoring;
        const compiled = value(await compileDraft(draft, runtime));
        assert.ok(compiled.migration.steps.length > 0);
        const sql = compiled.migration.steps.map(step => files.resources.get(step.run.name).text);
        if (kind === "inferred") assert.ok(sql.some(text => /ADD COLUMN/.test(text)));
        if (kind === "data") assert.ok(compiled.operations.some(operation => operation.dataMigrationIds.length > 0));
        if (kind === "destructive") {
            assert.equal(sql.filter(text => /DROP COLUMN/.test(text)).length, 2);
            await lateFailure(compiled, files);
        }
        process.stdout.write(`PostgreSQL example ${kind}: generated artifact replay passed\n`);
    }
    const project = await studentProject("destructive");
    const {draft, runtime, files, context} = project.authoring;
    const transformation = context.transformations["copy-email"];
    const invalidOutputSql = 'SELECT i.__source_id, i."studentId", i.email, \'not-an-integer\'::text AS unused FROM migration_input AS i;\n';
    const invalidRef = {...transformation.query, contentHash: textHash(invalidOutputSql)};
    value(await files.emitResource({ref: invalidRef, text: invalidOutputSql}));
    context.transformations["copy-email"] = {...transformation, query: invalidRef,
        outputs: {...transformation.outputs, unused: {domain: {side: "to", type: "integer", nullable: false}, field: null}}};
    const invalid = await compileDraft(draft, runtime);
    assert.equal(invalid.ok, false, "even an unwritten output must pass its historical domain validator");
    assert.ok(invalid.problems.some(problem => problem.field === "unused"), JSON.stringify(invalid));
    process.stdout.write("PostgreSQL historical validation: invalid unused transformation output rejected before writes\n");
}
main().catch(error => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

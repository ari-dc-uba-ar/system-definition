import {compileDraft} from "../src/authoring";
import * as assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {
    authoringEmailDataMigration,
    authoringEmailDecisions,
    authoringEmailSnapshotA,
    authoringEmailSnapshotB,
    authoringEmailSource,
    authoringEmailDraft,
    authoringEmailSchemaA,
    authoringEmailSchemaB,
} from "../fixtures/authoring-email";
import {authoringEmailResources} from "../fixtures/authoring-email/resources";

const consumerRoot = resolve(__dirname, "../..");
const repositoryRoot = resolve(consumerRoot, "../..");

interface PackageJson {
    scripts?: Record<string, string>;
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

describe("T22 final CLI/CI and PostgreSQL authoring integration contract", () => {
    it("wires the dedicated authoring matrix into the existing real-PostgreSQL integration command", () => {
        const packageJson = readJson(resolve(consumerRoot, "package.json")) as PackageJson;
        const integration = packageJson.scripts?.["test-integration"] ?? "";
        assert.match(
            integration,
            /test-authoring-integration\.js/,
            "test-integration must execute the T22 authoring matrix, not only the server-version probe",
        );
    });

    it("keeps the real matrix on the existing plan, artifact resolver, runner and deployment gate", () => {
        const path = resolve(consumerRoot, "scripts/test-authoring-integration.js");
        assert.ok(existsSync(path), "T22 requires a dedicated real-PostgreSQL authoring integration harness");
        const script = readFileSync(path, "utf8");
        assert.match(script, /buildMigrationPlan/);
        assert.match(script, /resolveMigrationExecutionContext/);
        assert.match(script, /executeMigrationPath/);
        assert.match(script, /checkDeploymentReady/);
        assert.doesNotMatch(script, /expectedSchema\s*:\s*observed/i, "the harness must not fake the SSOT oracle");
    });

    it("runs the section-11 fixture through the real SSOT and authoring contracts", async () => {
        assert.ok(authoringEmailSnapshotA.entities.alumnos?.fields.email_anterior);
        assert.ok(authoringEmailSnapshotA.entities.alumnos?.fields.nota_legacy);
        assert.ok(authoringEmailSnapshotB.entities.alumnos?.fields.email);
        assert.equal(authoringEmailSnapshotB.entities.alumnos?.fields.email_anterior, undefined);
        assert.match(authoringEmailSource.sql, /email_anterior/);
        assert.equal(authoringEmailDataMigration.transformation, "move-email");
        assert.ok(authoringEmailDecisions.some(decision => decision.resolution.kind === "migrate"));
        assert.ok(authoringEmailDecisions.some(decision => decision.resolution.kind === "discard"));

        const prepared = await authoringEmailResources();
        const compiled = await compileDraft(authoringEmailDraft, {
            async loadRelease(ref) { return {ok: true, value: {ref, expectedSchema: authoringEmailSchemaB}}; },
            async reconstructHistory() { return {ok: true, value: authoringEmailSchemaA}; },
            async inspectDraft() { return {ok: true, value: authoringEmailSchemaA}; },
            // This unit test isolates emission; the PostgreSQL matrix exercises actual replay.
            async inspectCompiled() { return {ok: true, value: authoringEmailSchemaB}; },
            async readQuery(ref) {
                const query = prepared.files.resources.get(ref.name);
                assert.ok(query);
                return {ok: true, value: query.text};
            },
            emitResource: prepared.files.emitResource.bind(prepared.files),
            loadDataContext: prepared.loadDataContext,
        });
        if (!compiled.ok) assert.fail(JSON.stringify(compiled.problems));
        assert.equal(compiled.value.migration.from.releaseId, "A");
        assert.equal(compiled.value.migration.to.releaseId, "B");
        assert.ok(compiled.value.operations.some(operation => operation.dataMigrationIds.includes("move-email")));
        const dataOperation = compiled.value.operations.find(operation => operation.dataMigrationIds.includes("move-email"));
        assert.ok(dataOperation);
        assert.ok(dataOperation.stepIds.length > 0,
            "the email example must compile its transformation to executable steps");
        assert.ok(dataOperation.stepIds.every(id => compiled.value.migration.steps.some(step => step.id === id)));
        const steps = compiled.value.migration.steps;
        const lastDataStep = Math.max(...dataOperation.stepIds.map(id => steps.findIndex(step => step.id === id)));
        const dropSteps = steps.map((step, index) => ({index, sql: prepared.files.resources.get(step.run.name)!.text}))
            .filter(step => /DROP COLUMN/u.test(step.sql));
        assert.equal(dropSteps.length, 2);
        assert.ok(dropSteps.every(step => step.index > lastDataStep), "data writes and conservation must precede both source drops");
    });

    it("executes generated-only, manual and mixed paths plus a blocking rollback case", () => {
        const path = resolve(consumerRoot, "scripts/test-authoring-integration.js");
        assert.ok(existsSync(path), "T22 requires a real authoring integration harness");
        const script = readFileSync(path, "utf8");
        assert.match(script, /generated-only/);
        assert.match(script, /manual/);
        assert.match(script, /mixed/);
        assert.match(script, /rollback/);
        assert.match(script, /zero activations|activationCount|activations/u);
    });

    it("keeps CI non-interactive and generated documentation explicit about pending authoring", () => {
        const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/postgres-migrations.yml"), "utf8");
        assert.match(workflow, /npm --prefix consumers\/postgres-migrations run test-integration/);
        assert.doesNotMatch(workflow, /continue-on-error:\s*true/);

        const generator = readFileSync(resolve(consumerRoot, "scripts/generate-readme.js"), "utf8");
        assert.match(generator, /generated-only/);
        assert.match(generator, /manual/);
        assert.match(generator, /mixed/);
        assert.match(generator, /non-interactive/i);
        assert.match(generator, /migration\.authoringPending/);
    });
});

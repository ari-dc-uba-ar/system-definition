import * as assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {
    authoringEmailDataMigration,
    authoringEmailDecisions,
    authoringEmailSnapshotA,
    authoringEmailSnapshotB,
    authoringEmailSource,
    compileAuthoringEmailExample,
} from "../fixtures/authoring-email";

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

        const compiled = await compileAuthoringEmailExample();
        assert.equal(compiled.ok, true, compiled.ok ? undefined : JSON.stringify(compiled.problems));
        if (!compiled.ok) return;
        assert.equal(compiled.value.migration.from.releaseId, "A");
        assert.equal(compiled.value.migration.to.releaseId, "B");
        assert.ok(compiled.value.operations.some(operation => operation.dataMigrationIds.includes("move-email")));
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

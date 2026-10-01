import * as assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

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

    it("uses the section-11 fixture with email transfer and explicit legacy-note discard", () => {
        const path = resolve(consumerRoot, "fixtures/authoring-email/index.ts");
        assert.ok(existsSync(path), "T22 requires the section-11 authoring fixture");
        const fixture = readFileSync(path, "utf8");
        assert.match(fixture, /email_anterior/);
        assert.match(fixture, /nota_legacy/);
        assert.match(fixture, /\bemail\b/);
        assert.match(fixture, /discard/);
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

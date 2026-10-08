import {strict as assert} from "node:assert";
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, it} from "mocha";
import * as preparation from "../src/preparation";

const consumerRoot = resolve(__dirname, "../..");
const repositoryRoot = resolve(consumerRoot, "../..");
const HASH_RE = /^[0-9a-f]{64}$/;

type PreparationHistoryEntry = {
    ordinal: number;
    preparationId: string;
    artifactHash: string;
    headReleaseHash: string;
    beforeFingerprint: string;
    afterFingerprint: string;
};

type PreparationModule = typeof preparation & {
    verifyResolution?: unknown;
    applyResolution?: unknown;
    computePreparationHistoryHash?: (history: readonly PreparationHistoryEntry[]) => string;
};

const api = preparation as PreparationModule;

function source(relativePath: string): string {
    return readFileSync(resolve(consumerRoot, relativePath), "utf8");
}

describe("T23 final preparation execution, journal and deployment integration contract", () => {
    it("exposes separate verify-resolution and apply-resolution execution over the shared preparation artifact", () => {
        assert.equal(typeof api.verifyResolution, "function", "verify-resolution must be a library operation, not CLI-only SQL");
        assert.equal(typeof api.applyResolution, "function", "apply-resolution must be a distinct explicit library operation");

        const preparationSource = source("src/preparation-execution.ts");
        assert.match(preparationSource, /PreparationReceiptInfo/);
        assert.match(preparationSource, /status\s*:\s*["']passed["']\s*\|\s*["']failed["']\s*\|\s*["']incomplete["']/);
        assert.match(preparationSource, /checkPreparationPreconditions/);
        assert.match(preparationSource, /executeMigration|executeMigrationPath/);
    });

    it("journals attempts and confirmed preparations without advancing migration head and reconciles duplicate or ambiguous execution", () => {
        const journal = source("src/journal-schema.ts") + source("src/journal-preparations.ts");
        assert.match(journal, /preparation_attempts/);
        assert.match(journal, /preparations/);
        assert.match(journal, /preparation_id/);
        assert.match(journal, /artifact_hash/);
        assert.match(journal, /before_fingerprint/);
        assert.match(journal, /after_fingerprint/);
        assert.match(journal, /unknown|ambiguous/i);
    });

    it("hashes ordered confirmed preparation history so every successful correction invalidates prior deployment evidence", () => {
        assert.equal(typeof api.computePreparationHistoryHash, "function");
        if (typeof api.computePreparationHistoryHash !== "function") return;

        const empty = api.computePreparationHistoryHash([]);
        const one = api.computePreparationHistoryHash([{
            ordinal: 1,
            preparationId: "prep-1",
            artifactHash: "a".repeat(64),
            headReleaseHash: "b".repeat(64),
            beforeFingerprint: "c".repeat(64),
            afterFingerprint: "d".repeat(64),
        }]);
        const first: PreparationHistoryEntry = {
            ordinal: 1,
            preparationId: "prep-1",
            artifactHash: "a".repeat(64),
            headReleaseHash: "b".repeat(64),
            beforeFingerprint: "c".repeat(64),
            afterFingerprint: "d".repeat(64),
        };
        const second: PreparationHistoryEntry = {
            ordinal: 2,
            preparationId: "prep-2",
            artifactHash: "e".repeat(64),
            headReleaseHash: "b".repeat(64),
            beforeFingerprint: "d".repeat(64),
            afterFingerprint: "f".repeat(64),
        };
        const two = api.computePreparationHistoryHash([first, second]);
        const reordered = api.computePreparationHistoryHash([second, first]);
        assert.match(empty, HASH_RE);
        assert.match(one, HASH_RE);
        assert.match(two, HASH_RE);
        assert.notEqual(empty, one);
        assert.notEqual(one, two);
        assert.notEqual(two, reordered);

        const integration = source("scripts/test-conflict-resolution-integration.js");
        assert.match(integration, /preparationHistoryHash/);
        assert.match(integration, /configurationHash/);
        assert.match(integration, /evidence|verification/i);
    });

    it("adds only explicit resolver/preparation commands and keeps deployment commands non-interactive", () => {
        const cli = source("src/cli.ts");
        assert.match(cli, /["']resolve["']/);
        assert.match(cli, /["']verify-resolution["']/);
        assert.match(cli, /["']apply-resolution["']/);

        const examplesPath = resolve(consumerRoot, "test/fixtures/cli-doc-examples.json");
        const examples = readFileSync(examplesPath, "utf8");
        assert.match(examples, /"command"\s*:\s*"resolve"/);
        assert.match(examples, /"command"\s*:\s*"verify-resolution"/);
        assert.match(examples, /"command"\s*:\s*"apply-resolution"/);

        const readme = source("README.md");
        assert.match(readme, /postgres-migrations resolve/);
        assert.match(readme, /postgres-migrations verify-resolution/);
        assert.match(readme, /postgres-migrations apply-resolution/);
        assert.match(readme, /non-interactive/i);
        assert.match(readme, /stdin|prompt/i);
    });

    it("wires the T23 PostgreSQL matrix into the existing integration job and reuses runner, journal and deployment gate", () => {
        const packageJson = JSON.parse(source("package.json")) as {scripts?: Record<string, string>};
        assert.match(packageJson.scripts?.["test-integration"] ?? "", /test-conflict-resolution-integration\.js/);

        const scriptPath = resolve(consumerRoot, "scripts/test-conflict-resolution-integration.js");
        assert.equal(existsSync(scriptPath), true, "T23 requires a real PostgreSQL conflict/preparation integration harness");
        const script = readFileSync(scriptPath, "utf8");
        assert.match(script, /verifyResolution/);
        assert.match(script, /applyResolution/);
        assert.match(script, /executeMigration|executeMigrationPath/);
        assert.match(script, /checkDeploymentReady/);
        assert.match(script, /preparation_attempts|preparations/);
        assert.match(script, /PostgreSQL 18\.6|180006/);

        const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/postgres-migrations.yml"), "utf8");
        assert.match(workflow, /npm --prefix consumers\/postgres-migrations run test-integration/);
        assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
    });

    it("covers rollback, fingerprint drift, ambiguous commit, evidence invalidation and irreparable published SQL with zero activation", () => {
        const path = resolve(consumerRoot, "scripts/test-conflict-resolution-integration.js");
        assert.equal(existsSync(path), true, "T23 final integration harness must exist");
        const script = readFileSync(path, "utf8");
        assert.match(script, /fingerprint.*changed|changed.*fingerprint/i);
        assert.match(script, /rollback/i);
        assert.match(script, /commit.*ambiguous|ambiguous.*commit|commitUnknown/i);
        assert.match(script, /no[- ]?op|duplicate.*preparation|idempot/i);
        assert.match(script, /preparationHistoryHash/);
        assert.match(script, /irreparable|blocked.*published|published.*blocked/i);
        assert.match(script, /zero activations|activationCount|activations/u);
        assert.match(script, /head.*unchanged|history.*unchanged|same head|same history/i);
        assert.match(script, /drift.*restore|restore.*drift|extra column/i);
        assert.match(script, /incomplete.*receipt|receipt.*incomplete/i);
        assert.match(script, /head B|confirmed.*B|stale.*A/i);
    });
});

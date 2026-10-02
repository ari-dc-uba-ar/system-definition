import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {FileInfo, ReleaseRefInfo, ResourceInfo, ResourceRefInfo} from "system-definition";
import type {DestructiveDecisionInfo, QueryResourceInfo} from "../src/authoring-contract";
import type {SourceSelectionInfo} from "../src/migration-authoring";
import type {RehearsalCopyRef} from "../src/rehearsal";
import {
    checkPreparationPreconditions,
    computePreparationArtifactHash,
    createPreparationArtifact,
    decodePreparationArtifact,
    type PreparationArtifactInfo,
    type PreparationPreflightStateInfo,
} from "../src/preparation";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);
const H5 = "5".repeat(64);
const H6 = "6".repeat(64);
const H7 = "7".repeat(64);
const H8 = "8".repeat(64);
const H9 = "9".repeat(64);

const HEAD: ReleaseRefInfo = {systemId: "aida", releaseId: "B", releaseHash: H1};

function file(path: string, contentHash: string, byteLength = 10): FileInfo {
    return {path, contentHash, byteLength};
}

const PREP_SQL: ResourceRefInfo = {name: "repair-source", kind: "sql", contentHash: H6};
const COVERAGE: ResourceRefInfo = {name: "capture-covered", kind: "check", contentHash: H7};

const resources: Readonly<Record<string, ResourceInfo>> = {
    [PREP_SQL.name]: {kind: "sql", file: file("sql/repair-source.sql", H6)},
    [COVERAGE.name]: {kind: "check", file: file("checks/capture-covered.sql", H7)},
};

const queryResources: Readonly<Record<string, QueryResourceInfo>> = {
    capture_people: {kind: "query", file: file("queries/capture-people.sql", H5)},
};

const inputCapture: readonly SourceSelectionInfo[] = [{
    query: {name: "capture_people", kind: "query", contentHash: H5},
    ports: {
        id: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "alumnos", field: "alumno"},
        },
        legacy: {
            domain: {side: "from", type: "text", nullable: true},
            field: {side: "from", entity: "alumnos", field: "nota_legacy"},
        },
    },
    identity: ["id"],
    coverageChecks: [COVERAGE],
}];

const decisions: readonly DestructiveDecisionInfo[] = [{
    changeId: "restore:app.alumnos.nota_legacy",
    source: {side: "from", entity: "alumnos", field: "nota_legacy"},
    partitionCheck: null,
    resolution: {kind: "discard", reason: "explicitly authorized test fixture"},
}];

type PreparationInput = Omit<PreparationArtifactInfo, "artifactHash">;

function input(overrides: Partial<PreparationInput> = {}): PreparationInput {
    return {
        formatVersion: 1,
        id: "prep-report-1",
        reportHash: H2,
        installationId: "installation-1",
        head: HEAD,
        historyHash: H3,
        observedSchemaHash: H4,
        inputFingerprint: H9,
        requestedPlanHash: H8,
        steps: [{id: "repair-source", run: PREP_SQL}],
        before: [COVERAGE],
        after: [COVERAGE],
        checkpoints: [],
        decisions,
        resources,
        queryResources,
        validationArtifacts: [],
        inputCapture,
        expectedSchemaHash: H5,
        ...overrides,
    };
}

function artifact(overrides: Partial<PreparationInput> = {}): PreparationArtifactInfo {
    const made = createPreparationArtifact(input(overrides), H5);
    assert.equal(made.ok, true);
    if (!made.ok) throw new Error("preparation fixture must be valid");
    return made.value;
}

function copy(overrides: Partial<RehearsalCopyRef> = {}): RehearsalCopyRef {
    return {
        copyId: "copy-preparation-1",
        provenance: "backup:failed-installation-1",
        installationId: "installation-1",
        source: HEAD,
        schemas: ["app"],
        ...overrides,
    };
}

function preflight(overrides: Partial<PreparationPreflightStateInfo> = {}): PreparationPreflightStateInfo {
    return {
        copy: copy(),
        installationId: "installation-1",
        head: HEAD,
        historyHash: H3,
        observedSchemaHash: H4,
        inputFingerprint: H9,
        requestedPlanHash: H8,
        ...overrides,
    };
}

describe("T23 immutable preparation artifact and copy preflight", () => {
    it("hashes every preparation field except artifactHash itself", () => {
        const one = artifact();
        assert.equal(one.artifactHash, computePreparationArtifactHash(one));

        const same = {...one, artifactHash: "0".repeat(64)};
        assert.equal(computePreparationArtifactHash(same), one.artifactHash);

        const changedFingerprint = {...one, inputFingerprint: H7};
        assert.notEqual(computePreparationArtifactHash(changedFingerprint), one.artifactHash);
        const changedPlan = {...one, requestedPlanHash: H6};
        assert.notEqual(computePreparationArtifactHash(changedPlan), one.artifactHash);
        const changedReport = {...one, reportHash: H4};
        assert.notEqual(computePreparationArtifactHash(changedReport), one.artifactHash);
    });

    it("strictly decodes a detached artifact and requires expectedSchemaHash to be the head schema hash", () => {
        const original = artifact();
        const decoded = decodePreparationArtifact(original, H5);
        assert.equal(decoded.ok, true);
        if (!decoded.ok) return;
        assert.deepEqual(decoded.value, original);
        assert.notEqual(decoded.value, original);
        assert.notEqual(decoded.value.inputCapture, original.inputCapture);

        assert.equal(decodePreparationArtifact(original, H6).ok, false);
        assert.equal(decodePreparationArtifact({...original, extra: true}, H5).ok, false);
        assert.equal(decodePreparationArtifact({...original, artifactHash: H6}, H5).ok, false);
    });

    it("closes every captured query and referenced SQL/check over immutable resources", () => {
        assert.equal(createPreparationArtifact(input(), H5).ok, true);

        const missingQuery = input({queryResources: {}});
        assert.equal(createPreparationArtifact(missingQuery, H5).ok, false);

        const changedQuery = input({
            queryResources: {
                capture_people: {kind: "query", file: file("queries/capture-people.sql", H6)},
            },
        });
        assert.equal(createPreparationArtifact(changedQuery, H5).ok, false);

        const missingCheck = input({
            resources: {[PREP_SQL.name]: resources[PREP_SQL.name]!},
        });
        assert.equal(createPreparationArtifact(missingCheck, H5).ok, false);

        const countOnlyCapture = input({
            inputCapture: [{...inputCapture[0]!, identity: []}],
        });
        assert.equal(createPreparationArtifact(countOnlyCapture, H5).ok, false);
    });

    it("requires an exact identified copy and rejects a changed fingerprint before any preparation write", () => {
        const value = artifact();
        assert.equal(checkPreparationPreconditions(value, preflight()).ok, true);

        assert.equal(checkPreparationPreconditions(value, preflight({inputFingerprint: H6})).ok, false);
        assert.equal(checkPreparationPreconditions(value, preflight({historyHash: H7})).ok, false);
        assert.equal(checkPreparationPreconditions(value, preflight({observedSchemaHash: H7})).ok, false);
        assert.equal(checkPreparationPreconditions(value, preflight({requestedPlanHash: H7})).ok, false);
        assert.equal(checkPreparationPreconditions(value, preflight({
            copy: copy({installationId: "another-installation"}),
        })).ok, false);
        assert.equal(checkPreparationPreconditions(value, preflight({
            copy: copy({source: {systemId: HEAD.systemId, releaseId: "A", releaseHash: H7}}),
        })).ok, false);
    });

    it("keeps preparation bound to the failed installation/head without mutating migration history or inventing a new release", () => {
        const source = input();
        const originalHead = {...source.head};
        const made = createPreparationArtifact(source, H5);
        assert.equal(made.ok, true);
        if (!made.ok) return;

        assert.deepEqual(made.value.head, originalHead);
        assert.equal(made.value.historyHash, H3);
        assert.equal(made.value.installationId, "installation-1");
        assert.equal(made.value.reportHash, H2);
        assert.equal(made.value.requestedPlanHash, H8);
        assert.equal(made.value.expectedSchemaHash, H5);
        assert.equal("to" in (made.value as unknown as Record<string, unknown>), false);
        assert.deepEqual(source.head, originalHead);
    });
});

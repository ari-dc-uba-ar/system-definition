import {strict as assert} from "node:assert";
import {createHash} from "node:crypto";
import {describe, it} from "mocha";
import {
    canonicalJson,
    toJsonValue,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {computeDraftRevisionHash} from "../src/authoring-cli";
import {
    createConflictReport,
    type ConflictReportInfo,
} from "../src/conflict-report";
import {
    resolveConflict,
    type ResolutionRuntime,
    type ResolutionStateInfo,
} from "../src/resolve-conflict";
import type {
    AuthoringReleaseBundle,
    DestructiveDecisionInfo,
    MigrationDraftInfo,
    PendingQuestionInfo,
} from "../src/authoring-contract";
import type {SourceSelectionInfo} from "../src/migration-authoring";
import type {PgSchemaInfo} from "../src/pg-schema";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const A: ReleaseRefInfo = {systemId: "aida", releaseId: "A", releaseHash: HASH_A};
const B: ReleaseRefInfo = {systemId: "aida", releaseId: "B", releaseHash: HASH_B};
const EMPTY_SCHEMA: PgSchemaInfo = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []};

const QUESTION: PendingQuestionInfo = {
    id: "question-discard-legacy-note",
    kind: "destructive",
    subjects: ["app.alumnos.nota_legacy"],
    messageKey: "migration.authoringPending",
};

const DECISION: DestructiveDecisionInfo = {
    changeId: "remove:app.alumnos.nota_legacy",
    source: {side: "from", entity: "alumnos", field: "nota_legacy"},
    partitionCheck: null,
    resolution: {kind: "discard", reason: "legacy note is intentionally retired"},
};

function ok<T>(value: T): ValidationResult<T> {
    return {ok: true, value};
}

function schemaHash(schema: PgSchemaInfo): string {
    const json = toJsonValue(schema);
    assert.equal(json.ok, true);
    if (!json.ok) throw new Error("schema fixture must be strict JSON");
    return createHash("sha256").update(canonicalJson(json.value), "utf8").digest("hex");
}

function draft(): MigrationDraftInfo {
    const initial: MigrationDraftInfo = {
        formatVersion: 1,
        id: "draft-A-B",
        base: {
            from: A,
            to: B,
            fromSnapshotHash: HASH_A,
            toSnapshotHash: HASH_B,
            fromPersistenceHash: HASH_C,
            toPersistenceHash: HASH_D,
        },
        revisionHash: "0".repeat(64),
        renames: [],
        changes: [{
            id: DECISION.changeId,
            action: "remove",
            origin: "inferred",
            impact: "destructive",
            before: {
                schema: "app",
                kind: "column",
                name: "nota_legacy",
                parentName: "alumnos",
                signature: [],
            },
            after: null,
            differences: [],
            affectedFields: [DECISION.source!],
            dependsOn: [],
        }],
        data: [],
        decisions: [],
        manual: [],
        pending: [QUESTION],
    };
    const revision = computeDraftRevisionHash(initial);
    assert.equal(revision.ok, true);
    if (!revision.ok) throw new Error("draft fixture must hash");
    return {...initial, revisionHash: revision.value};
}

function reportForDraft(value: MigrationDraftInfo, overrides: Partial<Omit<ConflictReportInfo, "reportHash">> = {}): ConflictReportInfo {
    const created = createConflictReport({
        formatVersion: 1,
        reportId: "report-authoring-1",
        command: "migration infer",
        kind: "authoringDecision",
        phase: "authoring",
        systemId: "aida",
        draftHash: value.revisionHash,
        installationId: null,
        attemptId: null,
        confirmedHead: null,
        requestedTarget: B,
        planHash: null,
        observedSchemaHash: null,
        historyHash: null,
        questions: [QUESTION],
        problems: [{
            field: null,
            messageKey: "migration.authoringPending",
            severity: "blocking",
            details: {changeId: DECISION.changeId},
        }],
        evidenceRefs: [],
        ...overrides,
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("report fixture must hash");
    return created.value;
}

function answers(value: MigrationDraftInfo, report: ConflictReportInfo, decision: DestructiveDecisionInfo = DECISION): unknown {
    return {
        formatVersion: 1,
        reportHash: report.reportHash,
        draftHash: value.revisionHash,
        draft: value,
        answers: [{
            questionId: QUESTION.id,
            kind: "destructive",
            decision,
        }],
    };
}

class ReadOnlyRuntime implements ResolutionRuntime {
    inspections = 0;
    fingerprints = 0;

    constructor(readonly state: ResolutionStateInfo) {}

    async inspectInstallation(id: string): Promise<ValidationResult<ResolutionStateInfo>> {
        this.inspections++;
        assert.equal(id, this.state.installationId);
        return ok(this.state);
    }

    async fingerprintInputs(
        installationId: string,
        _selections: readonly SourceSelectionInfo[],
    ): Promise<ValidationResult<string>> {
        this.fingerprints++;
        assert.equal(installationId, this.state.installationId);
        return ok(HASH_D);
    }

    async loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<AuthoringReleaseBundle>> {
        return ok({ref, expectedSchema: EMPTY_SCHEMA});
    }

    async reconstructHistory(_head: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>> {
        return ok(EMPTY_SCHEMA);
    }

    async readQuery(_ref: {name: string; kind: "query"; contentHash: string}): Promise<ValidationResult<string>> {
        return ok("SELECT 1");
    }

    async inspectDraft(_draft: MigrationDraftInfo): Promise<ValidationResult<PgSchemaInfo>> {
        return ok(EMPTY_SCHEMA);
    }
}

function state(overrides: Partial<ResolutionStateInfo> = {}): ResolutionStateInfo {
    return {
        installationId: "installation-1",
        confirmedHead: A,
        historyHash: HASH_C,
        observedSchema: EMPTY_SCHEMA,
        unknownCommit: false,
        ...overrides,
    };
}

describe("T23 conflict resolver freshness and answer application", () => {
    it("rejects a destructive answer for a change outside the reported draft", async () => {
        const current = draft();
        const report = reportForDraft(current);
        const unrelated: DestructiveDecisionInfo = {
            ...DECISION,
            changeId: "remove:app.alumnos.unrelated",
            source: {side: "from", entity: "alumnos", field: "unrelated"},
        };

        const resolved = await resolveConflict(report, answers(current, report, unrelated), new ReadOnlyRuntime(state()));

        assert.equal(resolved.ok, false,
            "an unrelated decision must not clear the pending question and produce a resolved draft");
        if (!resolved.ok) assert.equal(resolved.problems[0]?.messageKey, "migration.invalidConflictResolution");
    });

    it("applies one exact versioned destructive answer and returns only a draftUpdated result", async () => {
        const current = draft();
        const report = reportForDraft(current);
        const runtime = new ReadOnlyRuntime(state());

        const resolved = await resolveConflict(report, answers(current, report), runtime);
        assert.equal(resolved.ok, true);
        if (!resolved.ok) return;

        assert.equal(resolved.value.kind, "draftUpdated");
        if (resolved.value.kind !== "draftUpdated") return;
        assert.equal(resolved.value.reportHash, report.reportHash);
        assert.deepEqual(resolved.value.draft.decisions, [DECISION]);
        assert.deepEqual(resolved.value.draft.pending, []);
        assert.notEqual(resolved.value.draft.revisionHash, current.revisionHash);
        const revision = computeDraftRevisionHash(resolved.value.draft);
        assert.equal(revision.ok, true);
        if (revision.ok) assert.equal(resolved.value.draft.revisionHash, revision.value);
        assert.equal(runtime.inspections, 0);
        assert.equal(runtime.fingerprints, 0);
    });

    it("rejects answers bound to another report or draft before reading installation state", async () => {
        const current = draft();
        const report = reportForDraft(current);
        const runtime = new ReadOnlyRuntime(state());

        const wrongReport = answers(current, report) as {
            formatVersion: 1;
            reportHash: string;
            draftHash: string;
            draft: MigrationDraftInfo;
            answers: readonly unknown[];
        };
        wrongReport.reportHash = HASH_D;
        assert.equal((await resolveConflict(report, wrongReport, runtime)).ok, false);

        const wrongDraft = answers(current, report) as {
            formatVersion: 1;
            reportHash: string;
            draftHash: string;
            draft: MigrationDraftInfo;
            answers: readonly unknown[];
        };
        wrongDraft.draftHash = HASH_D;
        assert.equal((await resolveConflict(report, wrongDraft, runtime)).ok, false);
        assert.equal(runtime.inspections, 0);
        assert.equal(runtime.fingerprints, 0);
    });

    it("re-reads installation state and rejects a report whose head, history or observed schema is stale", async () => {
        const current = draft();
        const report = reportForDraft(current, {
            kind: "targetData",
            installationId: "installation-1",
            confirmedHead: A,
            observedSchemaHash: schemaHash(EMPTY_SCHEMA),
            historyHash: HASH_C,
            questions: [],
        });
        const runtime = new ReadOnlyRuntime(state({historyHash: HASH_D}));

        const resolved = await resolveConflict(report, {formatVersion: 1, reportHash: report.reportHash, answers: []}, runtime);
        assert.equal(resolved.ok, false);
        assert.equal(runtime.inspections, 1);
        assert.equal(runtime.fingerprints, 0);
    });

    it("keeps commitUnknown blocked while durable reconciliation is still unknown", async () => {
        const current = draft();
        const report = reportForDraft(current, {
            kind: "commitUnknown",
            draftHash: null,
            installationId: "installation-1",
            attemptId: "attempt-1",
            confirmedHead: A,
            observedSchemaHash: schemaHash(EMPTY_SCHEMA),
            historyHash: HASH_C,
            questions: [],
        });
        const runtime = new ReadOnlyRuntime(state({unknownCommit: true}));

        const resolved = await resolveConflict(report, {formatVersion: 1, reportHash: report.reportHash, answers: []}, runtime);
        assert.equal(resolved.ok, true);
        if (!resolved.ok) return;
        assert.equal(resolved.value.kind, "blocked");
        assert.equal(resolved.value.reportHash, report.reportHash);
        assert.equal(runtime.inspections, 1);
        assert.equal(runtime.fingerprints, 0);
    });

    it("does not invent a destination when requestedTarget is null, even when an answer is supplied", async () => {
        const current = draft();
        const report = reportForDraft(current, {requestedTarget: null});
        const runtime = new ReadOnlyRuntime(state());

        const resolved = await resolveConflict(report, answers(current, report), runtime);
        assert.equal(resolved.ok, true);
        if (!resolved.ok) return;
        assert.equal(resolved.value.kind, "blocked");
        assert.equal(resolved.value.reportHash, report.reportHash);
        assert.equal(runtime.inspections, 0);
        assert.equal(runtime.fingerprints, 0);
    });
});

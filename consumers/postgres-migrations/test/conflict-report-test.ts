import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    computeConflictReportHash,
    createConflictReport,
    decodeConflictReport,
    type ConflictReportInfo,
} from "../src/conflict-report";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function report(): ConflictReportInfo {
    return {
        formatVersion: 1,
        reportId: "report-1",
        reportHash: "0".repeat(64),
        command: "migration infer",
        kind: "authoringDecision",
        phase: "authoring",
        systemId: "aida",
        draftHash: HASH_A,
        installationId: null,
        attemptId: null,
        confirmedHead: null,
        requestedTarget: {
            systemId: "aida",
            releaseId: "B",
            releaseHash: HASH_B,
        },
        planHash: null,
        observedSchemaHash: null,
        historyHash: null,
        questions: [{
            id: "question-1",
            kind: "destructive",
            subjects: ["app.alumnos.nota_legacy"],
            messageKey: "migration.authoringPending",
        }],
        problems: [{
            field: null,
            messageKey: "migration.authoringPending",
            severity: "blocking",
            details: {changeId: "drop:app.alumnos.nota_legacy"},
        }],
        evidenceRefs: [{
            path: "reports/details.json",
            contentHash: HASH_C,
            byteLength: 123,
        }],
    };
}

function validReport(): ConflictReportInfo {
    const value = report();
    value.reportHash = computeConflictReportHash(value);
    return value;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

describe("T23 immutable conflict reports", () => {
    it("hashes the complete diagnostic report except reportHash itself", () => {
        const base = report();
        const changedSelf = {...base, reportHash: "f".repeat(64)};
        const changedEvidence = {
            ...base,
            evidenceRefs: [{...base.evidenceRefs[0]!, contentHash: HASH_D}],
        };
        const changedQuestion = {
            ...base,
            questions: [{...base.questions[0]!, subjects: ["app.alumnos.email_anterior"]}],
        };

        assert.equal(computeConflictReportHash(base), computeConflictReportHash(changedSelf));
        assert.notEqual(computeConflictReportHash(base), computeConflictReportHash(changedEvidence));
        assert.notEqual(computeConflictReportHash(base), computeConflictReportHash(changedQuestion));
    });

    it("decodes the strict report shape, accepts requestedTarget null and returns a detached copy", () => {
        const source = validReport();
        source.requestedTarget = null;
        source.reportHash = computeConflictReportHash(source);

        const decoded = decodeConflictReport(source);
        assert.equal(decoded.ok, true);
        if (!decoded.ok) return;

        const mutable = source as unknown as {
            questions: {subjects: string[]}[];
            evidenceRefs: {path: string}[];
        };
        mutable.questions[0]!.subjects[0] = "mutated";
        mutable.evidenceRefs[0]!.path = "mutated.json";
        assert.equal(decoded.value.requestedTarget, null);
        assert.deepEqual(decoded.value.questions[0]!.subjects, ["app.alumnos.nota_legacy"]);
        assert.equal(decoded.value.evidenceRefs[0]!.path, "reports/details.json");
    });

    it("rejects unknown kinds, extra fields and malformed evidence refs instead of widening the report", () => {
        const unknownKind = clone(validReport()) as unknown as Record<string, unknown>;
        unknownKind.kind = "madeUpConflict";
        assert.equal(decodeConflictReport(unknownKind).ok, false);

        const extra = clone(validReport()) as unknown as Record<string, unknown>;
        extra.extra = true;
        assert.equal(decodeConflictReport(extra).ok, false);

        const malformed = clone(validReport()) as unknown as {evidenceRefs: {contentHash: string}[]};
        malformed.evidenceRefs[0]!.contentHash = "not-a-hash";
        assert.equal(decodeConflictReport(malformed).ok, false);
    });

    it("rejects a stale reportHash when reconciled state or diagnostic content changes", () => {
        const staleHead = clone(validReport());
        staleHead.confirmedHead = {
            systemId: "aida",
            releaseId: "B",
            releaseHash: HASH_B,
        };
        assert.equal(decodeConflictReport(staleHead).ok, false);

        const staleHistory = clone(validReport());
        staleHistory.historyHash = HASH_D;
        assert.equal(decodeConflictReport(staleHistory).ok, false);

        const staleProblem = clone(validReport()) as unknown as {problems: {details: Record<string, string>}[]};
        staleProblem.problems[0]!.details = {changeId: "different-change"};
        assert.equal(decodeConflictReport(staleProblem).ok, false);
    });

    it("produces a hashed diagnostic without inventing a target or turning it into authorizing evidence", () => {
        const source = report();
        source.requestedTarget = null;
        const {reportHash: _ignored, ...draft} = source;

        const created = createConflictReport(draft);
        assert.equal(created.ok, true);
        if (!created.ok) return;

        assert.equal(created.value.requestedTarget, null);
        assert.equal(created.value.reportHash, computeConflictReportHash(created.value));
        assert.equal(created.value.kind, "authoringDecision");
        assert.deepEqual(created.value.evidenceRefs, source.evidenceRefs);
    });
});

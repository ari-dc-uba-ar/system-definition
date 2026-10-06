import {
    decodeFileInfo,
    decodeProblem as decodeProblemInfo,
    decodeReleaseRefInfo,
    exactKeys,
    isNonEmptyString,
    isPlainObject,
    isSha256,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import type {PendingQuestionInfo} from "./authoring-contract";
import {canonicalJsonSha256, omitJsonObjectKeys} from "./canonical-hash";

export type ConflictKind =
    | "authoringDecision"
    | "targetData"
    | "schemaDrift"
    | "historyIntegrity"
    | "artifactIntegrity"
    | "operational"
    | "commitUnknown";

export type ConflictReportInfo = {
    formatVersion: 1;
    reportId: string;
    reportHash: string;
    command: string;
    kind: ConflictKind;
    phase: string;
    systemId: string;
    draftHash: string | null;
    installationId: string | null;
    attemptId: string | null;
    confirmedHead: ReleaseRefInfo | null;
    requestedTarget: ReleaseRefInfo | null;
    planHash: string | null;
    observedSchemaHash: string | null;
    historyHash: string | null;
    questions: readonly PendingQuestionInfo[];
    problems: readonly Problem[];
    evidenceRefs: readonly FileInfo[];
};

type JsonObject = {readonly [key: string]: JsonValue};

const CONFLICT_KINDS: readonly ConflictKind[] = [
    "authoringDecision",
    "targetData",
    "schemaDrift",
    "historyIntegrity",
    "artifactIntegrity",
    "operational",
    "commitUnknown",
];
const QUESTION_KINDS: readonly PendingQuestionInfo["kind"][] = [
    "rename",
    "dataRequired",
    "destructive",
    "rowMapping",
    "unsupported",
];
const REPORT_KEYS = [
    "formatVersion",
    "reportId",
    "reportHash",
    "command",
    "kind",
    "phase",
    "systemId",
    "draftHash",
    "installationId",
    "attemptId",
    "confirmedHead",
    "requestedTarget",
    "planHash",
    "observedSchemaHash",
    "historyHash",
    "questions",
    "problems",
    "evidenceRefs",
] as const;

function failure<T>(reason: string): ValidationResult<T> {
    return {
        ok: false,
        problems: [{
            field: null,
            messageKey: "migration.invalidConflictReport",
            severity: "blocking",
            details: {reason},
        }],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}

function hashOrNull(value: JsonValue): value is string | null {
    return value === null || isSha256(value);
}

function opaqueIdOrNull(value: JsonValue): value is string | null {
    return value === null || isNonEmptyString(value);
}

function decodeReleaseRef(value: JsonValue, name: string): ValidationResult<ReleaseRefInfo | null> {
    if (value === null) return {ok: true, value: null};
    return decodeReleaseRefInfo(value, "$", () => failure(`invalid ${name}`));
}

function decodeQuestion(value: JsonValue): ValidationResult<PendingQuestionInfo> {
    if (!isObject(value)) return failure("invalid pending question");
    const shape = exactKeys(value, ["id", "kind", "subjects", "messageKey"], "$", () => failure("invalid pending question"));
    if (!shape.ok
        || !isNonEmptyString(value.id)
        || typeof value.kind !== "string"
        || !QUESTION_KINDS.includes(value.kind as PendingQuestionInfo["kind"])
        || !Array.isArray(value.subjects)
        || !isNonEmptyString(value.messageKey)) {
        return failure("invalid pending question");
    }
    const subjects: string[] = [];
    for (const subject of value.subjects) {
        if (!isNonEmptyString(subject)) return failure("pending question subjects must be non-empty strings");
        subjects.push(subject);
    }
    return {
        ok: true,
        value: {
            id: value.id,
            kind: value.kind as PendingQuestionInfo["kind"],
            subjects,
            messageKey: value.messageKey,
        },
    };
}

function decodeReportProblem(value: JsonValue): ValidationResult<Problem> {
    return decodeProblemInfo(value, "$", (path, _reason) => (
        path.includes('["details"]["')
            ? failure("problem details must be strings")
            : failure("invalid problem")
    ));
}

function decodeEvidenceFile(value: JsonValue): ValidationResult<FileInfo> {
    return decodeFileInfo(value, "$", () => failure("invalid evidence file reference"));
}

function hashableReport(report: ConflictReportInfo): JsonValue {
    const converted = toJsonValue(report);
    if (!converted.ok || !isObject(converted.value)) {
        throw new TypeError("conflict report is not strict JSON");
    }
    return omitJsonObjectKeys(converted.value, ["reportHash"]);
}

export function computeConflictReportHash(report: ConflictReportInfo): string {
    return canonicalJsonSha256(hashableReport(report));
}

function decodeReport(value: unknown, verifyHash: boolean): ValidationResult<ConflictReportInfo> {
    const converted = toJsonValue(value);
    if (!converted.ok) return failure("report must be strict JSON");
    const raw = converted.value;
    if (!isObject(raw)) return failure("invalid conflict report shape");
    const reportShape = exactKeys(raw, REPORT_KEYS, "$", () => failure("invalid conflict report shape"));
    if (!reportShape.ok
        || raw.formatVersion !== 1
        || !isNonEmptyString(raw.reportId)
        || !isSha256(raw.reportHash)
        || !isNonEmptyString(raw.command)
        || typeof raw.kind !== "string"
        || !CONFLICT_KINDS.includes(raw.kind as ConflictKind)
        || !isNonEmptyString(raw.phase)
        || !isNonEmptyString(raw.systemId)
        || !hashOrNull(raw.draftHash)
        || !opaqueIdOrNull(raw.installationId)
        || !opaqueIdOrNull(raw.attemptId)
        || !hashOrNull(raw.planHash)
        || !hashOrNull(raw.observedSchemaHash)
        || !hashOrNull(raw.historyHash)
        || !Array.isArray(raw.questions)
        || !Array.isArray(raw.problems)
        || !Array.isArray(raw.evidenceRefs)) {
        return failure("invalid conflict report shape");
    }

    const confirmedHead = decodeReleaseRef(raw.confirmedHead, "confirmed head");
    if (!confirmedHead.ok) return confirmedHead;
    const requestedTarget = decodeReleaseRef(raw.requestedTarget, "requested target");
    if (!requestedTarget.ok) return requestedTarget;

    const questions: PendingQuestionInfo[] = [];
    for (const one of raw.questions) {
        const decoded = decodeQuestion(one);
        if (!decoded.ok) return decoded;
        questions.push(decoded.value);
    }

    const problems: Problem[] = [];
    for (const one of raw.problems) {
        const decoded = decodeReportProblem(one);
        if (!decoded.ok) return decoded;
        problems.push(decoded.value);
    }

    const evidenceRefs: FileInfo[] = [];
    for (const one of raw.evidenceRefs) {
        const decoded = decodeEvidenceFile(one);
        if (!decoded.ok) return decoded;
        evidenceRefs.push(decoded.value);
    }

    const report: ConflictReportInfo = {
        formatVersion: 1,
        reportId: raw.reportId,
        reportHash: raw.reportHash,
        command: raw.command,
        kind: raw.kind as ConflictKind,
        phase: raw.phase,
        systemId: raw.systemId,
        draftHash: raw.draftHash,
        installationId: raw.installationId,
        attemptId: raw.attemptId,
        confirmedHead: confirmedHead.value,
        requestedTarget: requestedTarget.value,
        planHash: raw.planHash,
        observedSchemaHash: raw.observedSchemaHash,
        historyHash: raw.historyHash,
        questions,
        problems,
        evidenceRefs,
    };

    if (verifyHash && report.reportHash !== computeConflictReportHash(report)) {
        return failure("stale conflict report hash");
    }
    return {ok: true, value: report};
}

export function decodeConflictReport(value: unknown): ValidationResult<ConflictReportInfo> {
    return decodeReport(value, true);
}

export function createConflictReport(
    draft: Omit<ConflictReportInfo, "reportHash">,
): ValidationResult<ConflictReportInfo> {
    const candidate = {...draft, reportHash: "0".repeat(64)};
    const decoded = decodeReport(candidate, false);
    if (!decoded.ok) return decoded;
    const report = decoded.value;
    report.reportHash = computeConflictReportHash(report);
    return {ok: true, value: report};
}

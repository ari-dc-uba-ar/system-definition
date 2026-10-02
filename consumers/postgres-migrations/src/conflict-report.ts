import {createHash} from "node:crypto";
import {
    canonicalJson,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import type {PendingQuestionInfo} from "./authoring-contract";

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

const HASH_RE = /^[0-9a-f]{64}$/;
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
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value: JsonValue): value is string {
    return typeof value === "string" && value.length > 0;
}

function hashOrNull(value: JsonValue): value is string | null {
    return value === null || (typeof value === "string" && HASH_RE.test(value));
}

function opaqueIdOrNull(value: JsonValue): value is string | null {
    return value === null || nonEmptyString(value);
}

function decodeReleaseRef(value: JsonValue, name: string): ValidationResult<ReleaseRefInfo | null> {
    if (value === null) return {ok: true, value: null};
    if (!isObject(value)
        || !hasExactKeys(value, ["systemId", "releaseId", "releaseHash"])
        || !nonEmptyString(value.systemId)
        || !nonEmptyString(value.releaseId)
        || typeof value.releaseHash !== "string"
        || !HASH_RE.test(value.releaseHash)) {
        return failure(`invalid ${name}`);
    }
    return {
        ok: true,
        value: {
            systemId: value.systemId,
            releaseId: value.releaseId,
            releaseHash: value.releaseHash,
        },
    };
}

function decodeQuestion(value: JsonValue): ValidationResult<PendingQuestionInfo> {
    if (!isObject(value)
        || !hasExactKeys(value, ["id", "kind", "subjects", "messageKey"])
        || !nonEmptyString(value.id)
        || typeof value.kind !== "string"
        || !QUESTION_KINDS.includes(value.kind as PendingQuestionInfo["kind"])
        || !Array.isArray(value.subjects)
        || !nonEmptyString(value.messageKey)) {
        return failure("invalid pending question");
    }
    const subjects: string[] = [];
    for (const subject of value.subjects) {
        if (!nonEmptyString(subject)) return failure("pending question subjects must be non-empty strings");
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

function decodeProblem(value: JsonValue): ValidationResult<Problem> {
    if (!isObject(value)
        || !hasExactKeys(value, ["field", "messageKey", "severity", "details"])
        || !(value.field === null || typeof value.field === "string")
        || !nonEmptyString(value.messageKey)
        || !(value.severity === "blocking" || value.severity === "regular")
        || !isObject(value.details)) {
        return failure("invalid problem");
    }
    const details: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, detail] of Object.entries(value.details)) {
        if (typeof detail !== "string") return failure("problem details must be strings");
        details[key] = detail;
    }
    return {
        ok: true,
        value: {
            field: value.field,
            messageKey: value.messageKey,
            severity: value.severity,
            details,
        },
    };
}

function decodeFileInfo(value: JsonValue): ValidationResult<FileInfo> {
    if (!isObject(value)
        || !hasExactKeys(value, ["path", "contentHash", "byteLength"])
        || !nonEmptyString(value.path)
        || typeof value.contentHash !== "string"
        || !HASH_RE.test(value.contentHash)
        || typeof value.byteLength !== "number"
        || !Number.isSafeInteger(value.byteLength)
        || value.byteLength < 0) {
        return failure("invalid evidence file reference");
    }
    return {
        ok: true,
        value: {
            path: value.path,
            contentHash: value.contentHash,
            byteLength: value.byteLength,
        },
    };
}

function hashableReport(report: ConflictReportInfo): JsonValue {
    const converted = toJsonValue(report);
    if (!converted.ok || !isObject(converted.value)) {
        throw new TypeError("conflict report is not strict JSON");
    }
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(converted.value)) {
        if (key !== "reportHash") result[key] = value;
    }
    return result;
}

export function computeConflictReportHash(report: ConflictReportInfo): string {
    return createHash("sha256").update(canonicalJson(hashableReport(report)), "utf8").digest("hex");
}

function decodeReport(value: unknown, verifyHash: boolean): ValidationResult<ConflictReportInfo> {
    const converted = toJsonValue(value);
    if (!converted.ok) return failure("report must be strict JSON");
    const raw = converted.value;
    if (!isObject(raw)
        || !hasExactKeys(raw, REPORT_KEYS)
        || raw.formatVersion !== 1
        || !nonEmptyString(raw.reportId)
        || typeof raw.reportHash !== "string"
        || !HASH_RE.test(raw.reportHash)
        || !nonEmptyString(raw.command)
        || typeof raw.kind !== "string"
        || !CONFLICT_KINDS.includes(raw.kind as ConflictKind)
        || !nonEmptyString(raw.phase)
        || !nonEmptyString(raw.systemId)
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
        const decoded = decodeProblem(one);
        if (!decoded.ok) return decoded;
        problems.push(decoded.value);
    }

    const evidenceRefs: FileInfo[] = [];
    for (const one of raw.evidenceRefs) {
        const decoded = decodeFileInfo(one);
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

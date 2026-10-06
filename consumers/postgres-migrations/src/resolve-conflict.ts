import {
    problem,
    sameReleaseRef,
    toJsonValue,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {computeDraftRevisionHash} from "./authoring-cli";
import {canonicalJsonSha256} from "./canonical-hash";
import {
    decodeDestructiveDecisionInfo,
    type AuthoringRuntime,
    type DestructiveDecisionInfo,
    type MigrationDraftInfo,
} from "./authoring-contract";
import {
    decodeConflictReport,
    type ConflictReportInfo,
} from "./conflict-report";
import type {SourceSelectionInfo} from "./migration-authoring";
import type {PgSchemaInfo} from "./pg-schema";

export type ResolutionStateInfo = {
    installationId: string;
    confirmedHead: ReleaseRefInfo | null;
    historyHash: string;
    observedSchema: PgSchemaInfo;
    unknownCommit: boolean;
};

export interface ResolutionRuntime extends AuthoringRuntime {
    inspectInstallation(id: string): Promise<ValidationResult<ResolutionStateInfo>>;
    fingerprintInputs(
        installationId: string,
        selections: readonly SourceSelectionInfo[],
    ): Promise<ValidationResult<string>>;
}

export type ResolutionResultInfo =
    | {kind: "draftUpdated"; reportHash: string; draft: MigrationDraftInfo}
    | {kind: "blocked"; reportHash: string; problems: readonly Problem[]};

type JsonObject = Readonly<Record<string, unknown>>;

type DestructiveAnswerInfo = {
    questionId: string;
    kind: "destructive";
    decision: DestructiveDecisionInfo;
};

type ResolutionAnswersInfo = {
    formatVersion: 1;
    reportHash: string;
    draftHash: string | null;
    draft: MigrationDraftInfo | null;
    answers: readonly DestructiveAnswerInfo[];
};

const HASH_RE = /^[0-9a-f]{64}$/;

function failure<T>(reason: string): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidConflictResolution", "blocking", {reason})],
    };
}

function blocked(reportHash: string, reason: string): ValidationResult<ResolutionResultInfo> {
    return {
        ok: true,
        value: {
            kind: "blocked",
            reportHash,
            problems: [problem(null, "migration.conflictBlocked", "blocking", {reason})],
        },
    };
}

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, required: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...required].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactKeysOneOf(value: JsonObject, variants: readonly (readonly string[])[]): boolean {
    return variants.some(keys => exactKeys(value, keys));
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function sameOptionalRelease(left: ReleaseRefInfo | null, right: ReleaseRefInfo | null): boolean {
    if (left === null || right === null) return left === right;
    return sameReleaseRef(left, right);
}

function schemaHash(schema: PgSchemaInfo): ValidationResult<string> {
    const converted = toJsonValue(schema);
    if (!converted.ok) return converted;
    return {
        ok: true,
        value: canonicalJsonSha256(converted.value),
    };
}

function decodeAnswers(value: unknown, report: ConflictReportInfo): ValidationResult<ResolutionAnswersInfo> {
    const converted = toJsonValue(value);
    if (!converted.ok) return failure("answers must be strict JSON");
    const raw = converted.value as unknown;
    if (!isObject(raw)
        || !exactKeysOneOf(raw, [
            ["formatVersion", "reportHash", "answers"],
            ["formatVersion", "reportHash", "draftHash", "draft", "answers"],
        ])
        || raw.formatVersion !== 1
        || typeof raw.reportHash !== "string"
        || !HASH_RE.test(raw.reportHash)
        || !Array.isArray(raw.answers)) {
        return failure("invalid resolution answers shape");
    }

    if (raw.reportHash !== report.reportHash) {
        return failure("answers are bound to another conflict report");
    }

    const hasDraft = Object.prototype.hasOwnProperty.call(raw, "draftHash");
    let draftHash: string | null = null;
    let draft: MigrationDraftInfo | null = null;
    if (hasDraft) {
        if (typeof raw.draftHash !== "string" || !HASH_RE.test(raw.draftHash) || !isObject(raw.draft)) {
            return failure("invalid answer draft binding");
        }
        draftHash = raw.draftHash;
        draft = raw.draft as unknown as MigrationDraftInfo;
    }

    const answers: DestructiveAnswerInfo[] = [];
    for (let index = 0; index < raw.answers.length; index++) {
        const answer = raw.answers[index];
        if (!isObject(answer)
            || !exactKeys(answer, ["questionId", "kind", "decision"])
            || !nonEmptyString(answer.questionId)
            || answer.kind !== "destructive") {
            return failure("invalid conflict answer");
        }
        const decision = decodeDestructiveDecisionInfo(
            answer.decision,
            `answers[${index}]["decision"]`,
            (_path, reason) => failure(reason),
        );
        if (!decision.ok) return decision;
        answers.push({questionId: answer.questionId, kind: "destructive", decision: decision.value});
    }

    if (answers.length > 0 && (draftHash === null || draft === null)) {
        return failure("answers that edit a draft require an exact draft binding");
    }

    return {ok: true, value: {formatVersion: 1, reportHash: raw.reportHash, draftHash, draft, answers}};
}

function validateDraftBinding(
    report: ConflictReportInfo,
    answers: ResolutionAnswersInfo,
): ValidationResult<MigrationDraftInfo> {
    if (report.draftHash === null || answers.draftHash === null || answers.draft === null) {
        return failure("report does not carry an editable draft binding");
    }
    if (answers.draftHash !== report.draftHash || answers.draft.revisionHash !== report.draftHash) {
        return failure("answers are bound to another draft");
    }
    const recomputed = computeDraftRevisionHash(answers.draft);
    if (!recomputed.ok) return recomputed;
    if (recomputed.value !== answers.draft.revisionHash) {
        return failure("answer draft revision hash is stale");
    }
    return {ok: true, value: answers.draft};
}

function applyDestructiveAnswer(
    report: ConflictReportInfo,
    answers: ResolutionAnswersInfo,
): ValidationResult<ResolutionResultInfo> {
    if (answers.answers.length !== 1) {
        return failure("exactly one pending conflict answer is required in this resolver slice");
    }
    const bound = validateDraftBinding(report, answers);
    if (!bound.ok) return bound;
    const draft = bound.value;
    const answer = answers.answers[0]!;
    const question = draft.pending.find(one => one.id === answer.questionId);
    if (question === undefined || question.kind !== "destructive") {
        return failure("answer does not match a pending destructive question");
    }
    if (!report.questions.some(one => one.id === question.id && one.kind === question.kind)) {
        return failure("answer question is not part of the conflict report");
    }
    if (draft.decisions.some(one => one.changeId === answer.decision.changeId
        && JSON.stringify(one.source) === JSON.stringify(answer.decision.source)
        && JSON.stringify(one.partitionCheck) === JSON.stringify(answer.decision.partitionCheck))) {
        return failure("duplicate destructive decision");
    }

    const nextWithoutRevision: MigrationDraftInfo = {
        ...draft,
        decisions: [...draft.decisions, answer.decision],
        pending: draft.pending.filter(one => one.id !== question.id),
    };
    const revision = computeDraftRevisionHash(nextWithoutRevision);
    if (!revision.ok) return revision;
    const next: MigrationDraftInfo = {...nextWithoutRevision, revisionHash: revision.value};
    return {
        ok: true,
        value: {kind: "draftUpdated", reportHash: report.reportHash, draft: next},
    };
}

async function validateInstallationFreshness(
    report: ConflictReportInfo,
    runtime: ResolutionRuntime,
): Promise<ValidationResult<ResolutionStateInfo | null>> {
    if (report.installationId === null) return {ok: true, value: null};
    const current = await runtime.inspectInstallation(report.installationId);
    if (!current.ok) return current;
    if (current.value.installationId !== report.installationId) {
        return failure("installation id changed while resolving conflict");
    }
    if (!sameOptionalRelease(current.value.confirmedHead, report.confirmedHead)) {
        return failure("confirmed head changed since conflict report");
    }
    if (report.historyHash === null || current.value.historyHash !== report.historyHash) {
        return failure("migration history changed since conflict report");
    }
    if (report.observedSchemaHash === null) {
        return failure("installation-bound report lacks observed schema hash");
    }
    const observed = schemaHash(current.value.observedSchema);
    if (!observed.ok) return observed;
    if (observed.value !== report.observedSchemaHash) {
        return failure("observed schema changed since conflict report");
    }
    return current;
}

/**
 * Read-only conflict resolver boundary.
 *
 * This slice may update an unpublished draft returned to the caller, but it has
 * no target write capability and never mutates journal/deployment state.
 */
export async function resolveConflict(
    reportInput: ConflictReportInfo,
    answersInput: unknown,
    runtime: ResolutionRuntime,
): Promise<ValidationResult<ResolutionResultInfo>> {
    const report = decodeConflictReport(reportInput);
    if (!report.ok) return report;

    const answers = decodeAnswers(answersInput, report.value);
    if (!answers.ok) return answers;

    // A report without an explicit requested SSOT target cannot be resolved by
    // inference. A caller must obtain a new report bound to a valid target.
    if (report.value.requestedTarget === null) {
        return blocked(report.value.reportHash, "requested target is absent");
    }

    // Validate report/draft binding before any installation reads. Stale answer
    // files must be rejected without consulting mutable target state.
    if (answers.value.answers.length > 0) {
        const bound = validateDraftBinding(report.value, answers.value);
        if (!bound.ok) return bound;
    }

    const fresh = await validateInstallationFreshness(report.value, runtime);
    if (!fresh.ok) return fresh;

    if (report.value.kind === "commitUnknown") {
        if (fresh.value === null || fresh.value.unknownCommit) {
            return blocked(report.value.reportHash, "commit outcome remains ambiguous");
        }
        return blocked(report.value.reportHash, "commit outcome was reconciled; produce a fresh report before retry");
    }

    if (report.value.kind === "authoringDecision" && answers.value.answers.length > 0) {
        return applyDestructiveAnswer(report.value, answers.value);
    }

    return blocked(report.value.reportHash, "conflict requires a later resolver/preparation slice");
}

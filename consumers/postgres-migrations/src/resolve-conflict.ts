import {
    exactKeys,
    isNonEmptyString,
    isPlainObject,
    isSha256,
    problem,
    sameOptionalReleaseRef,
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
import {decodePreparationArtifact, type PreparationArtifactInfo} from "./preparation-artifact";
import {createHash} from "node:crypto";

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
    revalidateOperational?(report: ConflictReportInfo): Promise<ValidationResult<true>>;
}

export type ResolutionResultInfo =
    | {kind: "draftUpdated"; reportHash: string; draft: MigrationDraftInfo}
    | {kind: "preparation"; reportHash: string; artifact: PreparationArtifactInfo}
    | {kind: "retryEligibleForVerification"; reportHash: string; head: ReleaseRefInfo}
    | {kind: "blocked"; reportHash: string; problems: readonly Problem[]};


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
    preparation: unknown | null;
};


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
    const raw = converted.value;
    if (!isPlainObject(raw)) return failure("invalid resolution answers shape");
    const hasDraft = Object.prototype.hasOwnProperty.call(raw, "draftHash");
    const hasPreparation = Object.prototype.hasOwnProperty.call(raw, "preparation");
    const shape = exactKeys(
        raw,
        [...(hasDraft
            ? ["formatVersion", "reportHash", "draftHash", "draft", "answers"]
            : ["formatVersion", "reportHash", "answers"]), ...(hasPreparation ? ["preparation"] : [])],
        "$",
        () => failure("invalid resolution answers shape"),
    );
    if (!shape.ok
        || raw.formatVersion !== 1
        || !isSha256(raw.reportHash)
        || !Array.isArray(raw.answers)) {
        return failure("invalid resolution answers shape");
    }

    if (raw.reportHash !== report.reportHash) {
        return failure("answers are bound to another conflict report");
    }

    let draftHash: string | null = null;
    let draft: MigrationDraftInfo | null = null;
    if (hasDraft) {
        if (!isSha256(raw.draftHash) || !isPlainObject(raw.draft)) {
            return failure("invalid answer draft binding");
        }
        draftHash = raw.draftHash;
        draft = raw.draft as unknown as MigrationDraftInfo;
    }

    const answers: DestructiveAnswerInfo[] = [];
    for (let index = 0; index < raw.answers.length; index++) {
        const answer = raw.answers[index];
        if (!isPlainObject(answer)) return failure("invalid conflict answer");
        const answerShape = exactKeys(
            answer,
            ["questionId", "kind", "decision"],
            `answers[${index}]`,
            () => failure("invalid conflict answer"),
        );
        if (!answerShape.ok
            || !isNonEmptyString(answer.questionId)
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

    if (hasPreparation && (hasDraft || answers.length > 0)) return failure("Preparation and draft answers are separate resolution actions");
    return {ok: true, value: {formatVersion: 1, reportHash: raw.reportHash, draftHash, draft, answers, preparation: raw.preparation ?? null}};
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
    if (answers.answers.length === 0) return failure("At least one pending answer is required");
    const bound = validateDraftBinding(report, answers);
    if (!bound.ok) return bound;
    const draft = bound.value;
    const decisions = [...draft.decisions];
    const resolvedQuestions = new Set<string>();
    for (const answer of answers.answers) {
    const question = draft.pending.find(one => one.id === answer.questionId);
    if (question === undefined || question.kind !== "destructive") {
        return failure("answer does not match a pending destructive question");
    }
    if (!report.questions.some(one => one.id === question.id && one.kind === question.kind)) {
        return failure("answer question is not part of the conflict report");
    }
    const change = draft.changes.find(one => one.id === answer.decision.changeId);
    if (change === undefined || change.impact !== "destructive") {
        return failure("answer does not reference a destructive change in the draft");
    }
    const source = answer.decision.source;
    if (source === null ? change.affectedFields.length !== 0 : !change.affectedFields.some(field =>
        field.side === source.side && field.entity === source.entity && field.field === source.field)) {
        return failure("answer source is not affected by the destructive change");
    }
    const sourceIdentity = change.before;
    const subject = sourceIdentity === null ? "" : [sourceIdentity.schema, sourceIdentity.parentName, sourceIdentity.name].filter(one => one !== null).join(".");
    if (!question.subjects.includes(change.id) && !question.subjects.includes(subject)) {
        return failure("answer does not address this question's destructive subject");
    }
    if (answer.decision.resolution.kind === "discard" && answer.decision.resolution.reason.trim().length === 0) return failure("Discard requires a reason");
    if (answer.decision.resolution.kind === "migrate") {
        const resolution = answer.decision.resolution;
        const data = draft.data.find(one => one.id === resolution.dataMigrationId);
        if (data === undefined || source === null
            || !Object.values(data.source.ports).some(port => port.field?.side === source.side && port.field.entity === source.entity && port.field.field === source.field)
            || !resolution.outputs.every(output => data.writes.some(write => write.values.some(binding => binding.output === output)))) {
            return failure("Migrate answer must consume the source and write every selected output");
        }
    }
    if (decisions.some(one => one.changeId === answer.decision.changeId
        && JSON.stringify(one.source) === JSON.stringify(answer.decision.source)
        && JSON.stringify(one.partitionCheck) === JSON.stringify(answer.decision.partitionCheck))) {
        return failure("duplicate destructive decision");
    }
    decisions.push(answer.decision);
    resolvedQuestions.add(question.id);
    }

    const nextWithoutRevision: MigrationDraftInfo = {
        ...draft,
        decisions,
        pending: draft.pending.filter(one => !resolvedQuestions.has(one.id)),
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
    if (!sameOptionalReleaseRef(current.value.confirmedHead, report.confirmedHead)) {
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

    if (report.value.kind === "historyIntegrity" || report.value.kind === "artifactIntegrity") {
        return blocked(report.value.reportHash, "Restore authentic history and artifacts before obtaining a new report");
    }
    if (fresh.value === null || fresh.value.confirmedHead === null || fresh.value.unknownCommit) {
        return blocked(report.value.reportHash, "A confirmed installation and commit outcome are required");
    }
    if (report.value.kind === "operational") {
        if (runtime.revalidateOperational === undefined) return blocked(report.value.reportHash, "Operational checks must be rerun before retry");
        const checked = await runtime.revalidateOperational(report.value);
        if (!checked.ok) return checked;
        return {ok: true, value: {kind: "retryEligibleForVerification", reportHash: report.value.reportHash, head: fresh.value.confirmedHead}};
    }
    if (report.value.kind === "targetData" || report.value.kind === "schemaDrift") {
        if (answers.value.preparation === null) return blocked(report.value.reportHash, "Provide an explicit preparation proposal; business transformations cannot be inferred");
        const head = await runtime.loadRelease(fresh.value.confirmedHead);
        if (!head.ok) return head;
        if (!sameReleaseRef(head.value.ref, fresh.value.confirmedHead)) return failure("Loaded head reference changed");
        const expected = schemaHash(head.value.expectedSchema);
        if (!expected.ok) return expected;
        const prepared = decodePreparationArtifact(answers.value.preparation, expected.value);
        if (!prepared.ok) return prepared;
        const artifact = prepared.value;
        if (artifact.reportHash !== report.value.reportHash || artifact.installationId !== fresh.value.installationId
            || !sameReleaseRef(artifact.head, fresh.value.confirmedHead) || artifact.historyHash !== fresh.value.historyHash
            || artifact.observedSchemaHash !== report.value.observedSchemaHash || artifact.requestedPlanHash !== report.value.planHash) {
            return failure("Preparation is bound to another report, installation, head, history, schema or plan");
        }
        const fingerprint = await runtime.fingerprintInputs(artifact.installationId, artifact.inputCapture);
        if (!fingerprint.ok) return fingerprint;
        if (fingerprint.value !== artifact.inputFingerprint) return failure("Relevant data changed since preparation was authored");
        if (runtime.readSql === undefined) return failure("Preparation resources must be read and verified");
        for (const [name, resource] of Object.entries(artifact.resources)) {
            const read = await runtime.readSql({name, kind: resource.kind, contentHash: resource.file.contentHash});
            if (!read.ok) return read;
            if (createHash("sha256").update(read.value).digest("hex") !== resource.file.contentHash) return failure("Preparation SQL checksum mismatch");
        }
        for (const [name, resource] of Object.entries(artifact.queryResources)) {
            const read = await runtime.readQuery({name, kind: "query", contentHash: resource.file.contentHash});
            if (!read.ok) return read;
            if (createHash("sha256").update(read.value).digest("hex") !== resource.file.contentHash) return failure("Preparation query checksum mismatch");
        }
        return {ok: true, value: {kind: "preparation", reportHash: report.value.reportHash, artifact}};
    }
    return blocked(report.value.reportHash, "The report still has unresolved authoring questions");
}

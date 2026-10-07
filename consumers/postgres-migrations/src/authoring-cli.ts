import {createHash} from "node:crypto";
import {
    hasExactKeys,
    isPlainObject,
    problem,
    toJsonValue,
    type Problem,
    type ValidationResult,
} from "system-definition";
import {canonicalJsonSha256} from "./canonical-hash";
import type {ManualStepInfo, MigrationDraftInfo, PendingQuestionInfo} from "./authoring-contract";
import {
    decodeDataMigration,
    type AuthoringContext,
    type DataMigrationInfo,
} from "./migration-authoring";

export type AddDataAnswerInfo = {
    questionId: string;
    kind: "add-data";
    dataMigration: unknown;
};

export type AddDataAnswersInfo = {
    formatVersion: 1;
    draftHash: string;
    answers: readonly AddDataAnswerInfo[];
};

export interface AuthoringDraftStore {
    readDraft(path: string): Promise<ValidationResult<MigrationDraftInfo>>;
    replaceDraftAtomic(path: string, next: MigrationDraftInfo): Promise<ValidationResult<true>>;
}

export interface AuthoringPrompt {
    ask(question: PendingQuestionInfo): Promise<AddDataAnswerInfo | null>;
}

export type AddDataSessionOptions = {
    draftPath: string;
    context: AuthoringContext;
    store: AuthoringDraftStore;
    nonInteractive: boolean;
    answers?: unknown;
    prompt?: AuthoringPrompt;
};

export type AddDataSessionReport = {
    ok: boolean;
    command: "add-data";
    draftPath: string;
    revisionHash: string;
    validation: {
        contracts: "passed" | "pending" | "failed";
        data: "notRun";
        problems: readonly Problem[];
    };
    questions: readonly PendingQuestionInfo[];
    problems: readonly Problem[];
    files: readonly {path: string; contentHash: string}[];
};

function oneProblem(messageKey: string, details: Readonly<Record<string, string>> = {}): readonly Problem[] {
    return [problem(null, messageKey, "blocking", details)];
}

function report(
    options: Pick<AddDataSessionOptions, "draftPath">,
    revisionHash: string,
    contracts: "passed" | "pending" | "failed",
    questions: readonly PendingQuestionInfo[],
    problems: readonly Problem[],
    files: readonly {path: string; contentHash: string}[] = [],
): AddDataSessionReport {
    return {
        ok: contracts === "passed" && questions.length === 0 && problems.length === 0,
        command: "add-data",
        draftPath: options.draftPath,
        revisionHash,
        validation: {contracts, data: "notRun", problems},
        questions,
        problems,
        files,
    };
}

function stableHash(value: unknown): ValidationResult<string> {
    const json = toJsonValue(value);
    if (!json.ok) return json;
    return {
        ok: true,
        value: canonicalJsonSha256(json.value),
    };
}

/**
 * Per the authoring contract, revisionHash deliberately excludes revisionHash,
 * derived changes/pending and reports.  It covers only authored authority.
 */
export function computeDraftRevisionHash(draft: MigrationDraftInfo): ValidationResult<string> {
    return stableHash({
        base: draft.base,
        renames: draft.renames,
        data: draft.data,
        decisions: draft.decisions,
        manual: draft.manual,
    });
}

function addDataQuestion(draft: MigrationDraftInfo): ValidationResult<PendingQuestionInfo> {
    const id = stableHash({kind: "add-data", draftHash: draft.revisionHash, draftId: draft.id});
    if (!id.ok) return id;
    return {
        ok: true,
        value: {
            id: id.value,
            kind: "dataRequired",
            subjects: [draft.id],
            messageKey: "migration.authoringPending",
        },
    };
}

function decodeAnswer(value: unknown, questionId: string): ValidationResult<AddDataAnswerInfo> {
    if (!isPlainObject(value)) {
        return {ok: false, problems: oneProblem("migration.authoringInvalid", {reason: "answer must be an object"})};
    }
    if (!hasExactKeys(value, ["questionId", "kind", "dataMigration"])) {
        return {ok: false, problems: oneProblem("migration.authoringInvalid", {reason: "unexpected add-data answer shape"})};
    }
    if (value.questionId !== questionId || value.kind !== "add-data") {
        return {
            ok: false,
            problems: oneProblem("migration.authoringInvalid", {
                reason: "answer does not match the pending add-data question",
            }),
        };
    }
    return {
        ok: true,
        value: {questionId, kind: "add-data", dataMigration: value.dataMigration},
    };
}

function decodeAnswersFile(value: unknown, draft: MigrationDraftInfo, questionId: string): ValidationResult<AddDataAnswerInfo | null> {
    const json = toJsonValue(value);
    if (!json.ok) return json;
    if (!isPlainObject(json.value)) {
        return {ok: false, problems: oneProblem("migration.authoringInvalid", {reason: "answers file must be an object"})};
    }
    if (!hasExactKeys(json.value, ["formatVersion", "draftHash", "answers"])) {
        return {ok: false, problems: oneProblem("migration.authoringInvalid", {reason: "unexpected answers file shape"})};
    }
    if (json.value.formatVersion !== 1 || typeof json.value.draftHash !== "string" || !Array.isArray(json.value.answers)) {
        return {ok: false, problems: oneProblem("migration.authoringInvalid", {reason: "invalid answers file"})};
    }
    if (json.value.draftHash !== draft.revisionHash) {
        return {
            ok: false,
            problems: oneProblem("migration.authoringStaleAnswers", {
                expectedDraftHash: draft.revisionHash,
                actualDraftHash: json.value.draftHash,
            }),
        };
    }
    if (json.value.answers.length === 0) return {ok: true, value: null};
    if (json.value.answers.length !== 1) {
        return {ok: false, problems: oneProblem("migration.authoringInvalid", {reason: "answers are duplicate or conflicting"})};
    }
    return decodeAnswer(json.value.answers[0], questionId);
}

function draftWithData(draft: MigrationDraftInfo, dataMigration: DataMigrationInfo): ValidationResult<MigrationDraftInfo> {
    if (draft.data.some(existing => existing.id === dataMigration.id)) {
        return {
            ok: false,
            problems: oneProblem("migration.authoringInvalid", {
                reason: "duplicate data migration id",
                dataMigrationId: dataMigration.id,
            }),
        };
    }
    const withoutRevision: MigrationDraftInfo = {
        ...draft,
        revisionHash: draft.revisionHash,
        data: [...draft.data, dataMigration],
    };
    const revision = computeDraftRevisionHash(withoutRevision);
    if (!revision.ok) return revision;
    return {ok: true, value: {...withoutRevision, revisionHash: revision.value}};
}

/**
 * Library boundary for `migration add-data`.
 *
 * The function never opens stdin itself.  Interactive input is supplied only
 * through the explicit prompt adapter; non-interactive mode never calls it.
 */
export async function runAddDataSession(options: AddDataSessionOptions): Promise<AddDataSessionReport> {
    const loaded = await options.store.readDraft(options.draftPath);
    if (!loaded.ok) return report(options, "", "failed", [], loaded.problems);
    const draft = loaded.value;

    const questionResult = addDataQuestion(draft);
    if (!questionResult.ok) return report(options, draft.revisionHash, "failed", [], questionResult.problems);
    const question = questionResult.value;

    let answer: AddDataAnswerInfo | null = null;
    if (options.answers !== undefined) {
        const decoded = decodeAnswersFile(options.answers, draft, question.id);
        if (!decoded.ok) return report(options, draft.revisionHash, "failed", [], decoded.problems);
        answer = decoded.value;
    }

    if (answer === null && !options.nonInteractive && options.prompt !== undefined) {
        const prompted = await options.prompt.ask(question);
        if (prompted !== null) {
            const decoded = decodeAnswer(prompted, question.id);
            if (!decoded.ok) return report(options, draft.revisionHash, "failed", [question], decoded.problems);
            answer = decoded.value;
        }
    }

    if (answer === null) {
        const problems = oneProblem("migration.authoringPending", {questionId: question.id});
        return report(options, draft.revisionHash, "pending", [question], problems);
    }

    const completed = decodeDataMigration(options.context, answer.dataMigration);
    if (!completed.ok) return report(options, draft.revisionHash, "failed", [question], completed.problems);

    const next = draftWithData(draft, completed.value);
    if (!next.ok) return report(options, draft.revisionHash, "failed", [question], next.problems);

    const replaced = await options.store.replaceDraftAtomic(options.draftPath, next.value);
    if (!replaced.ok) return report(options, draft.revisionHash, "failed", [question], replaced.problems);

    return report(
        options,
        next.value.revisionHash,
        "passed",
        [],
        [],
        [{path: options.draftPath, contentHash: next.value.revisionHash}],
    );
}

export type AddSqlContractInfo = Omit<ManualStepInfo, "run"> & {
    resourceName: string;
};

export type AddSqlSessionOptions = {
    draftPath: string;
    store: AuthoringDraftStore;
    file: {path: string; text: string};
    contract: AddSqlContractInfo;
};

export type AddSqlSessionReport = {
    ok: boolean;
    command: "add-sql";
    draftPath: string;
    revisionHash: string;
    problems: readonly Problem[];
    files: readonly {path: string; contentHash: string}[];
};

function addSqlReport(
    options: Pick<AddSqlSessionOptions, "draftPath">,
    revisionHash: string,
    problems: readonly Problem[],
    files: readonly {path: string; contentHash: string}[] = [],
): AddSqlSessionReport {
    return {
        ok: problems.length === 0,
        command: "add-sql",
        draftPath: options.draftPath,
        revisionHash,
        problems,
        files,
    };
}

function draftWithManualStep(
    draft: MigrationDraftInfo,
    step: ManualStepInfo,
): ValidationResult<MigrationDraftInfo> {
    if (step.id.length === 0 || draft.manual.some(existing => existing.id === step.id)) {
        return {
            ok: false,
            problems: oneProblem("migration.authoringInvalid", {
                reason: "manual step id must be non-empty and unique",
                stepId: step.id,
            }),
        };
    }
    if (draft.manual.some(existing => existing.run.name === step.run.name)) {
        return {
            ok: false,
            problems: oneProblem("migration.authoringInvalid", {
                reason: "manual SQL resource name must be unique in the draft",
                resourceName: step.run.name,
            }),
        };
    }

    const withoutRevision: MigrationDraftInfo = {
        ...draft,
        manual: [...draft.manual, step],
    };
    const revision = computeDraftRevisionHash(withoutRevision);
    if (!revision.ok) return revision;
    return {ok: true, value: {...withoutRevision, revisionHash: revision.value}};
}

/**
 * Library boundary for `migration add-sql`.  The SQL resource hash covers the
 * exact UTF-8 bytes supplied by the caller, while the draft replacement is a
 * single atomic store operation.  File persistence is deliberately left to the
 * caller/CLI adapter; the returned file record binds the bytes to the resource.
 */
export async function runAddSqlSession(options: AddSqlSessionOptions): Promise<AddSqlSessionReport> {
    const loaded = await options.store.readDraft(options.draftPath);
    if (!loaded.ok) return addSqlReport(options, "", loaded.problems);
    const draft = loaded.value;

    if (options.file.path.length === 0 || options.contract.resourceName.length === 0) {
        return addSqlReport(
            options,
            draft.revisionHash,
            oneProblem("migration.authoringInvalid", {reason: "manual SQL path and resource name must be non-empty"}),
        );
    }

    const contentHash = createHash("sha256").update(options.file.text, "utf8").digest("hex");
    const {resourceName, ...contract} = options.contract;
    const step: ManualStepInfo = {
        ...contract,
        run: {name: resourceName, kind: "sql", contentHash},
    };
    const next = draftWithManualStep(draft, step);
    if (!next.ok) return addSqlReport(options, draft.revisionHash, next.problems);

    const replaced = await options.store.replaceDraftAtomic(options.draftPath, next.value);
    if (!replaced.ok) return addSqlReport(options, draft.revisionHash, replaced.problems);

    return addSqlReport(
        options,
        next.value.revisionHash,
        [],
        [{path: options.file.path, contentHash}],
    );
}


import {
    decodeProblem as decodeContractProblem,
    decodeReleaseRefInfo,
    exactKeys,
    isPlainObject,
    problem,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import type {PgSession, SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    ATTEMPT_STATE,
    ATTEMPT_STATES,
    type AttemptState,
    type InstallationScope,
    type JournalConfig,
} from "./journal-contracts";

export type QueryResult = Awaited<ReturnType<PgSession["query"]>>;
export type Row = Readonly<Record<string, unknown>>;

export const JOURNAL_FORMAT_VERSION = 1 as const;
export const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const ATTEMPT_STATE_SET = new Set<string>(ATTEMPT_STATES);

export function isAttemptState(value: unknown): value is AttemptState {
    return typeof value === "string" && ATTEMPT_STATE_SET.has(value);
}

export function isFinishedAttemptState(value: unknown): value is Exclude<AttemptState, "running"> {
    return isAttemptState(value) && value !== ATTEMPT_STATE.running;
}

export function sqlTextLiteral(value: string): string {
    return "'" + value.replaceAll("'", "''") + "'";
}

export function sqlTextLiterals(values: readonly string[]): string {
    return values.map(sqlTextLiteral).join(",");
}

export function sqlAttemptState(state: AttemptState): string {
    return sqlTextLiteral(state);
}

export function sqlAttemptStates(states: readonly AttemptState[]): string {
    return sqlTextLiterals(states);
}

export function failure<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

export function queryFailure<T>(error: unknown): ValidationResult<T> {
    return failure("migration.journalQueryFailed", {
        reason: error instanceof Error ? error.message : "journal query failed",
    });
}

export function journalShape(
    row: Row,
    expected: readonly string[],
    reason: string,
): ValidationResult<true> {
    return exactKeys(
        row,
        expected,
        "$",
        () => failure("migration.invalidJournal", {reason}),
    );
}

export function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function decodeReleaseParts(
    systemId: unknown,
    releaseId: unknown,
    releaseHash: unknown,
): ValidationResult<ReleaseRefInfo> {
    const decoded = decodeReleaseRefInfo(
        {systemId, releaseId, releaseHash},
        "$",
        () => failure("migration.invalidJournal", {reason: "invalid release reference"}),
    );
    if (!decoded.ok) return decoded;
    if (!isPgNonEmptyText(decoded.value.systemId) || !isPgNonEmptyText(decoded.value.releaseId)) {
        return failure("migration.invalidJournal", {reason: "invalid release reference"});
    }
    return decoded;
}

export function validateRelease(value: ReleaseRefInfo): ValidationResult<ReleaseRefInfo> {
    return decodeReleaseParts(value.systemId, value.releaseId, value.releaseHash);
}

export function canonicalSchemas(schemas: readonly string[]): ValidationResult<readonly string[]> {
    if (!Array.isArray(schemas) || schemas.length === 0) {
        return failure("migration.invalidJournal", {reason: "installation scope must contain at least one schema"});
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const schema of schemas) {
        if (!isPgNonEmptyText(schema)) {
            return failure("migration.invalidJournal", {reason: "invalid application schema"});
        }
        if (seen.has(schema)) {
            return failure("migration.invalidJournal", {reason: "duplicate application schema", schema});
        }
        seen.add(schema);
        result.push(schema);
    }
    result.sort();
    return {ok: true, value: result};
}

export function validateScope(scope: InstallationScope): ValidationResult<InstallationScope> {
    if (!isPlainObject(scope)) return failure("migration.invalidJournal", {reason: "invalid installation scope"});
    const shape = journalShape(scope, ["systemId", "schemas"], "invalid installation scope");
    if (!shape.ok) return shape;
    if (!isPgNonEmptyText(scope.systemId)) {
        return failure("migration.invalidJournal", {reason: "invalid system id"});
    }
    const schemas = canonicalSchemas(scope.schemas);
    if (!schemas.ok) return schemas;
    return {ok: true, value: {systemId: scope.systemId, schemas: schemas.value}};
}

export function validateConfig(config: JournalConfig): ValidationResult<JournalConfig> {
    if (!isPlainObject(config)) return failure("migration.invalidJournal", {reason: "invalid journal schema"});
    const shape = journalShape(config, ["schema"], "invalid journal schema");
    if (!shape.ok) return shape;
    if (!isPgNonEmptyText(config.schema)) return failure("migration.invalidJournal", {reason: "invalid journal schema"});
    return {ok: true, value: {schema: config.schema}};
}

export function validateConfigForScope(
    config: JournalConfig,
    scope: InstallationScope,
): ValidationResult<{config: JournalConfig; scope: InstallationScope}> {
    const checkedConfig = validateConfig(config);
    if (!checkedConfig.ok) return checkedConfig;
    const checkedScope = validateScope(scope);
    if (!checkedScope.ok) return checkedScope;
    if (checkedScope.value.schemas.includes(checkedConfig.value.schema)) {
        return failure("migration.invalidJournal", {
            reason: "journal schema must be separate from managed application schemas",
            schema: checkedConfig.value.schema,
        });
    }
    return {ok: true, value: {config: checkedConfig.value, scope: checkedScope.value}};
}

function decodeAttemptProblem(value: unknown): ValidationResult<Problem> {
    const decoded = decodeContractProblem(value, "$", (_path, reason) => failure(
        "migration.invalidJournal",
        {reason: reason === "problem detail must be a string" ? "problem details must be strings" : "invalid attempt problem"},
    ));
    if (!decoded.ok) return decoded;
    if (!isPgNonEmptyText(decoded.value.messageKey)) {
        return failure("migration.invalidJournal", {reason: "invalid attempt problem"});
    }
    return decoded;
}

export function decodeProblems(value: unknown): ValidationResult<readonly Problem[]> {
    if (!Array.isArray(value)) return failure("migration.invalidJournal", {reason: "invalid attempt problems"});
    const result: Problem[] = [];
    for (const one of value) {
        const decoded = decodeAttemptProblem(one);
        if (!decoded.ok) return decoded;
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

export async function safeQuery(
    session: PgSession,
    text: string,
    values: readonly SqlParameter[],
): Promise<ValidationResult<QueryResult>> {
    try {
        return {ok: true, value: await session.query(text, values)};
    } catch (error) {
        return queryFailure(error);
    }
}

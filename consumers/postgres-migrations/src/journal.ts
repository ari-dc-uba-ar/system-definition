import {
    isPlainObject,
    isSha256,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    JOURNAL_FORMAT_VERSION,
    UTC_RE,
    canonicalSchemas,
    decodeProblems,
    decodeReleaseParts,
    failure,
    isAttemptState,
    isFinishedAttemptState,
    journalShape,
    positiveInteger,
    queryFailure,
    safeQuery,
    sameRelease,
    sqlAttemptState,
    sqlAttemptStates,
    validateConfig,
    validateConfigForScope,
    validateRelease,
    validateScope,
    type Row,
} from "./journal-internal";

export * from "./journal-contracts";

import {
    ATTEMPT_STATE,
    ATTEMPT_STATES,
    type AttemptFinishInput,
    type AttemptInfo,
    type AttemptStartInput,
    type AttemptState,
    type InstallationInfo,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
    type PgSessionFactory,
    type PreparationAttemptFinishInput,
    type PreparationAttemptInfo,
    type PreparationAttemptStartInput,
    type PreparationAttemptState,
    type PreparationHistoryInfo,
} from "./journal-contracts";

export {bootstrapJournal} from "./journal-schema";
export {finishAttempt, startAttempt} from "./journal-attempts";
export {
    finishPreparationAttempt,
    readConfirmedPreparation,
    readPreparationHistory,
    recordConfirmedPreparation,
    startPreparationAttempt,
} from "./journal-preparations";
export {
    appendCommittedMigration,
    installBaseline,
    readHistory,
    readInstallation,
    verifyHistory,
} from "./journal-history";

function lockScopeKey(scope: InstallationScope): string {
    return JSON.stringify({systemId: scope.systemId, schemas: [...scope.schemas].sort()});
}

function booleanField(row: unknown, key: string): boolean | null {
    if (!isPlainObject(row) || typeof row[key] !== "boolean") return null;
    return row[key];
}

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}


export async function withMigrationLock<T>(
    factory: PgSessionFactory,
    scope: InstallationScope,
    lockWaitTimeoutMs: number,
    work: (session: PgSession) => Promise<ValidationResult<T>>,
): Promise<ValidationResult<T>> {
    const checkedScope = validateScope(scope);
    if (!checkedScope.ok) return checkedScope;
    if (!Number.isFinite(lockWaitTimeoutMs) || !Number.isInteger(lockWaitTimeoutMs) || lockWaitTimeoutMs <= 0) {
        return failure("migration.invalidExecutionOptions", {field: "lockWaitTimeoutMs"});
    }
    if (factory === null || typeof factory !== "object" || typeof factory.openTarget !== "function" || typeof work !== "function") {
        return failure("migration.invalidJournal", {reason: "invalid migration lock arguments"});
    }

    let session: PgSession;
    try {
        session = await factory.openTarget();
    } catch (error) {
        return queryFailure(error);
    }

    const key = lockScopeKey(checkedScope.value);
    const lockSql = `SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || $1, 0)) AS locked`;
    const unlockSql = `SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || $1, 0)) AS unlocked`;
    let acquired = false;
    let result: ValidationResult<T> | null = null;
    const deadline = Date.now() + lockWaitTimeoutMs;

    try {
        while (true) {
            const locked = await safeQuery(session, lockSql, [key]);
            if (!locked.ok) {
                result = locked;
                break;
            }
            const value = locked.value.rows.length === 1 ? booleanField(locked.value.rows[0], "locked") : null;
            if (value === null) {
                result = failure("migration.invalidJournal", {reason: "invalid advisory lock response"});
                break;
            }
            if (value) {
                acquired = true;
                try {
                    result = await work(session);
                } catch (error) {
                    result = failure("migration.executionFailed", {
                        reason: error instanceof Error ? error.message : "migration work threw",
                    });
                }
                break;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                result = failure("migration.lockTimeout", {scope: key});
                break;
            }
            await wait(Math.min(25, remaining));
        }
    } finally {
        if (acquired) {
            try {
                await session.query(unlockSql, [key]);
            } catch {
                if (result?.ok !== false) {
                    result = failure("migration.journalQueryFailed", {reason: "could not release advisory lock explicitly"});
                }
            }
        }
        try {
            await session.close();
        } catch {
            if (result?.ok !== false) {
                result = failure("migration.journalQueryFailed", {reason: "could not close dedicated lock session"});
            }
        }
    }

    return result ?? failure("migration.executionFailed", {reason: "migration lock execution did not produce a result"});
}

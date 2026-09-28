import {
    problem,
    type Problem,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    readHistory,
    readInstallation,
    verifyHistory,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
} from "./journal";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";

export type CommitOutcomeState = "failed" | "unknown" | "succeeded";

export type CommitReconciliationContext = {
    journal: JournalConfig;
    scope: InstallationScope;
};

export type CommitOutcomeInfo = {
    attemptId: string;
    migrationId: string;
    migrationHash: string;
    state: CommitOutcomeState;
    confirmedHead: ReleaseRefInfo | null;
    retryAllowed: boolean;
    deploymentBlocked: boolean;
    keepMaintenance: true;
    problems: readonly Problem[];
};

type QueryResult = Awaited<ReturnType<PgSession["query"]>>;
type Row = Readonly<Record<string, unknown>>;

type AttemptSnapshot = {
    attemptId: string;
    installationId: string;
    state: "running" | "failed" | "unknown" | "succeeded";
    confirmedTarget: ReleaseRefInfo | null;
};

const HASH_RE = /^[0-9a-f]{64}$/;

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function queryFailure<T>(error: unknown): ValidationResult<T> {
    return fail("migration.journalQueryFailed", {
        reason: error instanceof Error ? error.message : "journal query failed",
    });
}

function isPlainObject(value: unknown): value is Row {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(row: Row, expected: readonly string[]): boolean {
    const actual = Object.keys(row).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function hashString(value: unknown): value is string {
    return typeof value === "string" && HASH_RE.test(value);
}

function sameRelease(left: ReleaseRefInfo, right: ReleaseRefInfo): boolean {
    return left.systemId === right.systemId
        && left.releaseId === right.releaseId
        && left.releaseHash === right.releaseHash;
}

function decodeReleaseParts(
    systemId: unknown,
    releaseId: unknown,
    releaseHash: unknown,
): ValidationResult<ReleaseRefInfo> {
    if (!nonEmptyString(systemId) || !nonEmptyString(releaseId) || !hashString(releaseHash)) {
        return fail("migration.invalidJournal", {reason: "invalid release reference in execution attempt"});
    }
    return {ok: true, value: {systemId, releaseId, releaseHash}};
}

function validateMigration(migration: PublishedMigrationInfo): ValidationResult<PublishedMigrationInfo> {
    if (migration === null || typeof migration !== "object"
        || !hashString(migration.migrationHash)
        || migration.migration === null || typeof migration.migration !== "object"
        || !nonEmptyString(migration.migration.id)
        || migration.migration.from === null || typeof migration.migration.from !== "object"
        || migration.migration.to === null || typeof migration.migration.to !== "object") {
        return fail("migration.invalidCatalog", {reason: "invalid published migration"});
    }
    const from = decodeReleaseParts(
        migration.migration.from.systemId,
        migration.migration.from.releaseId,
        migration.migration.from.releaseHash,
    );
    if (!from.ok) return fail("migration.invalidCatalog", {reason: "invalid migration origin"});
    const to = decodeReleaseParts(
        migration.migration.to.systemId,
        migration.migration.to.releaseId,
        migration.migration.to.releaseHash,
    );
    if (!to.ok) return fail("migration.invalidCatalog", {reason: "invalid migration target"});
    if (from.value.systemId !== to.value.systemId || sameRelease(from.value, to.value)) {
        return fail("migration.invalidCatalog", {reason: "migration must connect two releases of one system"});
    }
    return {ok: true, value: migration};
}

function attemptSelect(alias = "a"): string {
    return [
        `${alias}.attempt_id`,
        `${alias}.deployment_id`,
        `${alias}.installation_id`,
        `${alias}.plan_hash`,
        `${alias}.state`,
        `${alias}.confirmed_target_system_id`,
        `${alias}.confirmed_target_release_id`,
        `${alias}.confirmed_target_release_hash`,
        `${alias}.problems`,
    ].join(", ");
}

function decodeAttemptRow(value: unknown): ValidationResult<AttemptSnapshot> {
    const keys = [
        "attempt_id",
        "deployment_id",
        "installation_id",
        "plan_hash",
        "state",
        "confirmed_target_system_id",
        "confirmed_target_release_id",
        "confirmed_target_release_hash",
        "problems",
    ] as const;
    if (!isPlainObject(value) || !hasExactKeys(value, keys)
        || !nonEmptyString(value.attempt_id)
        || !nonEmptyString(value.deployment_id)
        || !nonEmptyString(value.installation_id)
        || !hashString(value.plan_hash)
        || !(value.state === "running" || value.state === "failed" || value.state === "unknown" || value.state === "succeeded")
        || !Array.isArray(value.problems)) {
        return fail("migration.invalidJournal", {reason: "invalid execution attempt row"});
    }

    const targetParts = [
        value.confirmed_target_system_id,
        value.confirmed_target_release_id,
        value.confirmed_target_release_hash,
    ];
    let confirmedTarget: ReleaseRefInfo | null = null;
    if (!targetParts.every(one => one === null)) {
        if (targetParts.some(one => one === null)) {
            return fail("migration.invalidJournal", {reason: "partial confirmed target in execution attempt"});
        }
        const decoded = decodeReleaseParts(targetParts[0], targetParts[1], targetParts[2]);
        if (!decoded.ok) return decoded;
        confirmedTarget = decoded.value;
    }
    if (value.state === "succeeded" && confirmedTarget === null) {
        return fail("migration.invalidJournal", {reason: "succeeded attempt lacks confirmed target"});
    }
    return {
        ok: true,
        value: {
            attemptId: value.attempt_id,
            installationId: value.installation_id,
            state: value.state,
            confirmedTarget,
        },
    };
}

async function readAttempt(
    session: PgSession,
    config: JournalConfig,
    attemptId: string,
): Promise<ValidationResult<AttemptSnapshot>> {
    if (!nonEmptyString(config.schema) || !nonEmptyString(attemptId)) {
        return fail("migration.invalidJournal", {reason: "invalid recovery journal/attempt"});
    }
    const table = `${quotePgIdentifier(config.schema)}.execution_attempt`;
    let result: QueryResult;
    try {
        result = await session.query(
            `SELECT ${attemptSelect("a")} FROM ${table} a WHERE a.attempt_id = $1`,
            [attemptId],
        );
    } catch (error) {
        return queryFailure(error);
    }
    if (result.rows.length !== 1) {
        return fail("migration.invalidJournal", {reason: "execution attempt is missing or not unique"});
    }
    const decoded = decodeAttemptRow(result.rows[0]);
    if (!decoded.ok) return decoded;
    if (decoded.value.attemptId !== attemptId) {
        return fail("migration.invalidJournal", {reason: "execution attempt id mismatch"});
    }
    return decoded;
}

function historyConfirmsMigration(
    history: readonly MigrationHistoryInfo[],
    migration: PublishedMigrationInfo,
): boolean {
    return history.some(one => one.migrationId === migration.migration.id
        && one.migrationHash === migration.migrationHash
        && sameRelease(one.from, migration.migration.from)
        && sameRelease(one.to, migration.migration.to));
}

function unknownProblem(migration: PublishedMigrationInfo, head: ReleaseRefInfo | null): Problem {
    return problem(null, "migration.unknownCommitOutcome", "blocking", {
        migrationId: migration.migration.id,
        migrationHash: migration.migrationHash,
        observedHead: head?.releaseId ?? "unknown",
    });
}

async function persistClassification(
    session: PgSession,
    config: JournalConfig,
    attempt: AttemptSnapshot,
    state: "failed" | "succeeded",
    confirmedTarget: ReleaseRefInfo | null,
    problems: readonly Problem[],
): Promise<ValidationResult<true>> {
    if (attempt.state === state) {
        if (state === "succeeded"
            && (attempt.confirmedTarget === null || confirmedTarget === null || !sameRelease(attempt.confirmedTarget, confirmedTarget))) {
            return fail("migration.invalidJournal", {reason: "attempt terminal target disagrees with durable migration outcome"});
        }
        return {ok: true, value: true};
    }
    if (attempt.state === "succeeded" || attempt.state === "failed") {
        return fail("migration.invalidJournal", {reason: "attempt terminal state disagrees with durable migration outcome"});
    }

    const table = `${quotePgIdentifier(config.schema)}.execution_attempt`;
    const values: readonly SqlParameter[] = [
        attempt.attemptId,
        state,
        confirmedTarget?.systemId ?? null,
        confirmedTarget?.releaseId ?? null,
        confirmedTarget?.releaseHash ?? null,
        JSON.stringify(problems),
    ];
    let result: QueryResult;
    try {
        result = await session.query(
            `UPDATE ${table}
                SET state = $2,
                    confirmed_target_system_id = $3,
                    confirmed_target_release_id = $4,
                    confirmed_target_release_hash = $5,
                    problems = $6::jsonb,
                    finished_at = clock_timestamp()
                WHERE attempt_id = $1 AND state IN ('running','unknown')
                RETURNING ${attemptSelect("execution_attempt")}`,
            values,
        );
    } catch (error) {
        return queryFailure(error);
    }
    if (result.rows.length !== 1) {
        return fail("migration.invalidJournal", {reason: "attempt could not be reconciled atomically"});
    }
    const decoded = decodeAttemptRow(result.rows[0]);
    if (!decoded.ok) return decoded;
    if (decoded.value.state !== state) {
        return fail("migration.invalidJournal", {reason: "attempt reconciliation did not persist requested state"});
    }
    if (state === "succeeded"
        && (decoded.value.confirmedTarget === null || confirmedTarget === null || !sameRelease(decoded.value.confirmedTarget, confirmedTarget))) {
        return fail("migration.invalidJournal", {reason: "reconciled attempt target mismatch"});
    }
    return {ok: true, value: true};
}

function outcome(
    attemptId: string,
    migration: PublishedMigrationInfo,
    state: CommitOutcomeState,
    confirmedHead: ReleaseRefInfo | null,
    problems: readonly Problem[],
): CommitOutcomeInfo {
    return {
        attemptId,
        migrationId: migration.migration.id,
        migrationHash: migration.migrationHash,
        state,
        confirmedHead,
        retryAllowed: state === "failed",
        deploymentBlocked: state !== "succeeded",
        keepMaintenance: true,
        problems,
    };
}

export async function reconcileCommitOutcome(
    session: PgSession,
    attemptId: string,
    migration: PublishedMigrationInfo,
    context: CommitReconciliationContext,
): Promise<ValidationResult<CommitOutcomeInfo>> {
    if (session === null || typeof session !== "object" || typeof session.query !== "function") {
        return fail("migration.invalidJournal", {reason: "invalid recovery session"});
    }
    if (!nonEmptyString(attemptId)
        || context === null || typeof context !== "object"
        || context.journal === null || typeof context.journal !== "object"
        || context.scope === null || typeof context.scope !== "object") {
        return fail("migration.invalidJournal", {reason: "invalid recovery arguments"});
    }
    const checkedMigration = validateMigration(migration);
    if (!checkedMigration.ok) return checkedMigration;

    const attempt = await readAttempt(session, context.journal, attemptId);
    if (!attempt.ok) return attempt;

    const installation = await readInstallation(session, context.journal, context.scope);
    if (!installation.ok) return installation;
    if (installation.value === null) {
        const problems = [unknownProblem(checkedMigration.value, null)];
        return {ok: true, value: outcome(attemptId, checkedMigration.value, "unknown", null, problems)};
    }
    if (attempt.value.installationId !== installation.value.installationId) {
        return fail("migration.invalidJournal", {reason: "execution attempt belongs to another installation"});
    }
    if (installation.value.systemId !== checkedMigration.value.migration.from.systemId) {
        return fail("migration.invalidJournal", {reason: "migration system does not match installation"});
    }

    const history = await readHistory(session, context.journal, installation.value.installationId);
    if (!history.ok) return history;
    const verified = verifyHistory(installation.value, history.value);
    if (!verified.ok) return verified;

    const confirmedHead = installation.value.current;
    if (historyConfirmsMigration(verified.value, checkedMigration.value)) {
        const persisted = await persistClassification(
            session,
            context.journal,
            attempt.value,
            "succeeded",
            checkedMigration.value.migration.to,
            [],
        );
        if (!persisted.ok) return persisted;
        return {
            ok: true,
            value: outcome(attemptId, checkedMigration.value, "succeeded", confirmedHead, []),
        };
    }

    if (sameRelease(confirmedHead, checkedMigration.value.migration.from)) {
        const persisted = await persistClassification(
            session,
            context.journal,
            attempt.value,
            "failed",
            null,
            [],
        );
        if (!persisted.ok) return persisted;
        return {
            ok: true,
            value: outcome(attemptId, checkedMigration.value, "failed", confirmedHead, []),
        };
    }

    const problems = [unknownProblem(checkedMigration.value, confirmedHead)];
    return {
        ok: true,
        value: outcome(attemptId, checkedMigration.value, "unknown", confirmedHead, problems),
    };
}

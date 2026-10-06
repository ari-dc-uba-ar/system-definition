import {
    problem,
    sameReleaseRef,
    type Problem,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    readAttempt,
    readHistory,
    readInstallation,
    settleAttempt,
    verifyHistory,
    type AttemptState,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
} from "./journal";
import type {PgSession} from "./pg-schema";

export type CommitOutcomeState = Exclude<AttemptState, "running">;

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

const HASH_RE = /^[0-9a-f]{64}$/;

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function hashString(value: unknown): value is string {
    return typeof value === "string" && HASH_RE.test(value);
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
    if (from.value.systemId !== to.value.systemId || sameReleaseRef(from.value, to.value)) {
        return fail("migration.invalidCatalog", {reason: "migration must connect two releases of one system"});
    }
    return {ok: true, value: migration};
}

function historyConfirmsMigration(
    history: readonly MigrationHistoryInfo[],
    migration: PublishedMigrationInfo,
): boolean {
    return history.some(one => one.migrationId === migration.migration.id
        && one.migrationHash === migration.migrationHash
        && sameReleaseRef(one.from, migration.migration.from)
        && sameReleaseRef(one.to, migration.migration.to));
}

function unknownProblem(migration: PublishedMigrationInfo, head: ReleaseRefInfo | null): Problem {
    return problem(null, "migration.unknownCommitOutcome", "blocking", {
        migrationId: migration.migration.id,
        migrationHash: migration.migrationHash,
        observedHead: head?.releaseId ?? "unknown",
    });
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
        const persisted = await settleAttempt(session, context.journal, attemptId, {
            state: "succeeded",
            confirmedTarget: checkedMigration.value.migration.to,
            problems: [],
        });
        if (!persisted.ok) return persisted;
        return {
            ok: true,
            value: outcome(attemptId, checkedMigration.value, "succeeded", confirmedHead, []),
        };
    }

    if (sameReleaseRef(confirmedHead, checkedMigration.value.migration.from)) {
        const persisted = await settleAttempt(session, context.journal, attemptId, {
            state: "failed",
            confirmedTarget: null,
            problems: [],
        });
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

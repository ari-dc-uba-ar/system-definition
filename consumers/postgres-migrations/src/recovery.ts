import {
    decodePublishedMigrationInfo,
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
import {isPgNonEmptyText} from "./pg-text";

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

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function validateMigration(migration: PublishedMigrationInfo): ValidationResult<PublishedMigrationInfo> {
    const decoded = decodePublishedMigrationInfo(
        migration,
        "$",
        (path) => {
            if (path.startsWith('$["migration"]["from"]')) {
                return fail("migration.invalidCatalog", {reason: "invalid migration origin"});
            }
            if (path.startsWith('$["migration"]["to"]')) {
                return fail("migration.invalidCatalog", {reason: "invalid migration target"});
            }
            return fail("migration.invalidCatalog", {reason: "invalid published migration"});
        },
    );
    if (!decoded.ok) return decoded;

    const {id, from, to} = decoded.value.migration;
    if (!isPgNonEmptyText(id)
        || !isPgNonEmptyText(from.systemId)
        || !isPgNonEmptyText(from.releaseId)
        || !isPgNonEmptyText(to.systemId)
        || !isPgNonEmptyText(to.releaseId)) {
        return fail("migration.invalidCatalog", {reason: "invalid published migration"});
    }
    if (from.systemId !== to.systemId || sameReleaseRef(from, to)) {
        return fail("migration.invalidCatalog", {reason: "migration must connect two releases of one system"});
    }
    return decoded;
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
    if (!isPgNonEmptyText(attemptId)
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

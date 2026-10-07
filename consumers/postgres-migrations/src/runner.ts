import {
    problem,
    sameReleaseRef,
    type MigrationPathInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    executeMigration,
    type MigrationExecutionContext,
    type MigrationExecutionInfo,
} from "./execute-migration";
import type {PgSession} from "./pg-schema";

export type MigrationPathCommittedInfo = MigrationExecutionInfo & {
    migrationId: string;
    migrationHash: string;
};

export type MigrationPathExecutionInfo = {
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    committed: readonly MigrationPathCommittedInfo[];
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}


function validatePath(path: MigrationPathInfo): ValidationResult<MigrationPathInfo> {
    if (path === null || typeof path !== "object" || !Array.isArray(path.migrations)) {
        return fail("migration.invalidCatalog", {reason: "invalid migration path"});
    }
    let expected = path.from;
    for (const published of path.migrations) {
        if (!sameReleaseRef(published.migration.from, expected)) {
            return fail("migration.invalidCatalog", {
                migrationId: published.migration.id,
                reason: "migration path is not contiguous",
            });
        }
        expected = published.migration.to;
    }
    if (!sameReleaseRef(expected, path.to)) {
        return fail("migration.invalidCatalog", {reason: "migration path does not end at its declared target"});
    }
    return {ok: true, value: path};
}

export async function executeMigrationPath(
    session: PgSession,
    path: MigrationPathInfo,
    resolveContext: (
        migration: PublishedMigrationInfo,
    ) => Promise<ValidationResult<MigrationExecutionContext>> | ValidationResult<MigrationExecutionContext>,
): Promise<ValidationResult<MigrationPathExecutionInfo>> {
    const checkedPath = validatePath(path);
    if (!checkedPath.ok) return checkedPath;
    if (typeof resolveContext !== "function") {
        return fail("migration.invalidExecutionOptions", {reason: "missing migration execution context resolver"});
    }

    const committed: MigrationPathCommittedInfo[] = [];
    for (const published of checkedPath.value.migrations) {
        let context: ValidationResult<MigrationExecutionContext>;
        try {
            context = await resolveContext(published);
        } catch (error) {
            return fail("migration.executionFailed", {
                migrationId: published.migration.id,
                reason: error instanceof Error ? error.message : "context resolution failed",
            });
        }
        if (!context.ok) return context;
        const executed = await executeMigration(session, published, context.value);
        if (!executed.ok) return executed;
        committed.push({
            migrationId: published.migration.id,
            migrationHash: published.migrationHash,
            installation: executed.value.installation,
            history: executed.value.history,
        });
    }

    return {
        ok: true,
        value: {
            from: checkedPath.value.from,
            to: checkedPath.value.to,
            committed,
        },
    };
}

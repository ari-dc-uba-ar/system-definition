import {
    problem,
    type MigrationInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {ManagedDataInfo} from "./artifact";
import {compareSchemas} from "./compare-schema";
import {
    appendCommittedMigration,
    readHistory,
    readInstallation,
    verifyHistory,
    type InstallationInfo,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
} from "./journal";
import {checkManagedData} from "./managed-data";
import {inspectSchema, type InspectionScope} from "./inspect-schema";
import type {PgSchemaInfo, PgSession, ResolvedSqlResource} from "./pg-schema";
import {
    executePreparedSqlResource,
    prepareSqlResource,
    runCheckResource,
    type PreparedSqlResource,
} from "./sql-resource";

export type ReleaseExecutionState = {
    expectedSchema: PgSchemaInfo;
    inspection: InspectionScope;
    managedData: readonly ManagedDataInfo[];
    invariantChecks: readonly ResourceRefInfo[];
};

export type MigrationExecutionContext = {
    journal: JournalConfig;
    scope: InstallationScope;
    resources: Readonly<Record<string, ResolvedSqlResource>>;
    from: ReleaseExecutionState;
    to: ReleaseExecutionState;
    options: {
        statementTimeoutMs: number;
        lockTimeoutMs: number;
    };
    now(): string;
};

export type MigrationExecutionInfo = {
    installation: InstallationInfo;
    history: MigrationHistoryInfo;
};

type PreparedExecution = {
    before: readonly ResolvedSqlResource[];
    steps: readonly {id: string; resource: PreparedSqlResource}[];
    after: readonly ResolvedSqlResource[];
    targetInvariants: readonly ResolvedSqlResource[];
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function sameRelease(left: ReleaseRefInfo, right: ReleaseRefInfo): boolean {
    return left.systemId === right.systemId
        && left.releaseId === right.releaseId
        && left.releaseHash === right.releaseHash;
}

function sameResourceRef(left: ResourceRefInfo, right: ResourceRefInfo): boolean {
    return left.name === right.name && left.kind === right.kind && left.contentHash === right.contentHash;
}

function validMilliseconds(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function resolveResource(
    resources: Readonly<Record<string, ResolvedSqlResource>>,
    ref: ResourceRefInfo,
    kind: ResourceRefInfo["kind"],
): ValidationResult<ResolvedSqlResource> {
    if (ref.kind !== kind || typeof ref.name !== "string" || ref.name.length === 0) {
        return fail("migration.invalidReference", {reason: "resource kind/name does not match its migration position"});
    }
    const resolved = resources[ref.name];
    if (resolved === undefined || !sameResourceRef(resolved.ref, ref)) {
        return fail("migration.checksumMismatch", {name: ref.name, reason: "resolved resource does not match the published reference"});
    }
    return {ok: true, value: resolved};
}

function prepareExecution(
    migration: MigrationInfo,
    context: MigrationExecutionContext,
): ValidationResult<PreparedExecution> {
    if (!validMilliseconds(context.options.statementTimeoutMs) || !validMilliseconds(context.options.lockTimeoutMs)) {
        return fail("migration.invalidExecutionOptions", {reason: "statement/lock timeouts must be positive integer milliseconds"});
    }
    const before: ResolvedSqlResource[] = [];
    for (const ref of migration.before) {
        const resolved = resolveResource(context.resources, ref, "check");
        if (!resolved.ok) return resolved;
        before.push(resolved.value);
    }
    const steps: {id: string; resource: PreparedSqlResource}[] = [];
    const stepIds = new Set<string>();
    for (const step of migration.steps) {
        if (typeof step.id !== "string" || step.id.length === 0 || stepIds.has(step.id)) {
            return fail("migration.invalidReference", {reason: "migration step ids must be non-empty and unique"});
        }
        stepIds.add(step.id);
        const resolved = resolveResource(context.resources, step.run, "sql");
        if (!resolved.ok) return resolved;
        const prepared = prepareSqlResource(resolved.value);
        if (!prepared.ok) return prepared;
        steps.push({id: step.id, resource: prepared.value});
    }
    const after: ResolvedSqlResource[] = [];
    for (const ref of migration.after) {
        const resolved = resolveResource(context.resources, ref, "check");
        if (!resolved.ok) return resolved;
        after.push(resolved.value);
    }
    const targetInvariants: ResolvedSqlResource[] = [];
    for (const ref of context.to.invariantChecks) {
        const resolved = resolveResource(context.resources, ref, "check");
        if (!resolved.ok) return resolved;
        targetInvariants.push(resolved.value);
    }
    return {ok: true, value: {before, steps, after, targetInvariants}};
}

async function controlQuery(
    session: PgSession,
    text: string,
): Promise<ValidationResult<true>> {
    try {
        await session.query(text, []);
        return {ok: true, value: true};
    } catch (error) {
        return fail("migration.executionFailed", {
            statement: text,
            reason: error instanceof Error ? error.message : "database operation failed",
        });
    }
}

async function rollbackAfterFailure<T>(
    session: PgSession,
    original: ValidationResult<T>,
): Promise<ValidationResult<T>> {
    if (original.ok) return original;
    const rollback = await controlQuery(session, "ROLLBACK");
    if (rollback.ok) return original;
    return {ok: false, problems: [...original.problems, ...rollback.problems]};
}

async function checkSchema(
    session: PgSession,
    state: ReleaseExecutionState,
    phase: "source" | "target",
): Promise<ValidationResult<true>> {
    const inspected = await inspectSchema(session, state.inspection);
    if (!inspected.ok) return inspected;
    const compared = compareSchemas(state.expectedSchema, inspected.value);
    if (!compared.ok) return compared;
    if (!compared.value.equal) {
        const first = compared.value.differences[0];
        return fail("migration.schemaDrift", {
            phase,
            path: first === undefined ? "schema" : first.path.join("."),
            differenceCount: String(compared.value.differences.length),
        });
    }
    return {ok: true, value: true};
}

async function runChecks(
    session: PgSession,
    resources: readonly ResolvedSqlResource[],
): Promise<ValidationResult<true>> {
    for (const resource of resources) {
        const checked = await runCheckResource(session, resource);
        if (!checked.ok) return checked;
    }
    return {ok: true, value: true};
}

function validatePublishedMigration(migration: PublishedMigrationInfo): ValidationResult<PublishedMigrationInfo> {
    if (migration === null || typeof migration !== "object"
        || typeof migration.migrationHash !== "string" || !/^[0-9a-f]{64}$/.test(migration.migrationHash)
        || migration.migration === null || typeof migration.migration !== "object"
        || typeof migration.migration.id !== "string" || migration.migration.id.length === 0
        || migration.migration.from.systemId !== migration.migration.to.systemId
        || sameRelease(migration.migration.from, migration.migration.to)) {
        return fail("migration.invalidCatalog", {reason: "invalid published migration"});
    }
    return {ok: true, value: migration};
}

export async function executeMigration(
    session: PgSession,
    migration: PublishedMigrationInfo,
    context: MigrationExecutionContext,
): Promise<ValidationResult<MigrationExecutionInfo>> {
    const validMigration = validatePublishedMigration(migration);
    if (!validMigration.ok) return validMigration;
    const prepared = prepareExecution(validMigration.value.migration, context);
    if (!prepared.ok) return prepared;

    const begun = await controlQuery(session, "BEGIN");
    if (!begun.ok) return begun;
    let transactionOpen = true;

    const failInside = async <T>(result: ValidationResult<T>): Promise<ValidationResult<MigrationExecutionInfo>> => {
        if (!transactionOpen) return result as ValidationResult<MigrationExecutionInfo>;
        transactionOpen = false;
        return rollbackAfterFailure(session, result) as Promise<ValidationResult<MigrationExecutionInfo>>;
    };

    try {
        const statementTimeout = await controlQuery(
            session,
            `SET LOCAL statement_timeout = '${context.options.statementTimeoutMs}ms'`,
        );
        if (!statementTimeout.ok) return await failInside(statementTimeout);
        const lockTimeout = await controlQuery(
            session,
            `SET LOCAL lock_timeout = '${context.options.lockTimeoutMs}ms'`,
        );
        if (!lockTimeout.ok) return await failInside(lockTimeout);

        const installation = await readInstallation(session, context.journal, context.scope);
        if (!installation.ok) return await failInside(installation);
        if (installation.value === null) {
            return await failInside(fail("migration.headMismatch", {reason: "installation is missing"}));
        }
        if (!sameRelease(installation.value.current, migration.migration.from)) {
            return await failInside(fail("migration.headMismatch", {
                expected: migration.migration.from.releaseId,
                actual: installation.value.current.releaseId,
            }));
        }

        const history = await readHistory(session, context.journal, installation.value.installationId);
        if (!history.ok) return await failInside(history);
        const verifiedHistory = verifyHistory(installation.value, history.value);
        if (!verifiedHistory.ok) return await failInside(verifiedHistory);

        const sourceSchema = await checkSchema(session, context.from, "source");
        if (!sourceSchema.ok) return await failInside(sourceSchema);

        const before = await runChecks(session, prepared.value.before);
        if (!before.ok) return await failInside(before);

        for (const step of prepared.value.steps) {
            const executed = await executePreparedSqlResource(session, step.resource);
            if (!executed.ok) return await failInside(executed);
        }

        const after = await runChecks(session, prepared.value.after);
        if (!after.ok) return await failInside(after);
        const invariants = await runChecks(session, prepared.value.targetInvariants);
        if (!invariants.ok) return await failInside(invariants);
        const managed = await checkManagedData(session, context.to.managedData);
        if (!managed.ok) return await failInside(managed);
        const targetSchema = await checkSchema(session, context.to, "target");
        if (!targetSchema.ok) return await failInside(targetSchema);

        const committedAt = context.now();
        if (typeof committedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(committedAt)) {
            return await failInside(fail("migration.invalidExecutionOptions", {field: "now"}));
        }
        const historyEntry: MigrationHistoryInfo = {
            installationId: installation.value.installationId,
            ordinal: verifiedHistory.value.length + 1,
            migrationId: migration.migration.id,
            migrationHash: migration.migrationHash,
            from: migration.migration.from,
            to: migration.migration.to,
            committedAt,
        };
        const advanced = await appendCommittedMigration(
            session,
            context.journal,
            migration.migration.from,
            historyEntry,
        );
        if (!advanced.ok) return await failInside(advanced);

        const committed = await controlQuery(session, "COMMIT");
        transactionOpen = false;
        if (!committed.ok) {
            return fail("migration.commitUnknown", {
                migrationId: migration.migration.id,
                reason: committed.problems[0]?.details.reason ?? "commit result is unknown",
            });
        }
        return {ok: true, value: {installation: advanced.value, history: historyEntry}};
    } catch (error) {
        const failure = fail<MigrationExecutionInfo>("migration.executionFailed", {
            migrationId: migration.migration.id,
            reason: error instanceof Error ? error.message : "migration execution threw",
        });
        if (!transactionOpen) return failure;
        transactionOpen = false;
        return rollbackAfterFailure(session, failure);
    }
}

import {createHash} from "node:crypto";
import {
    problem,
    sameReleaseRef,
    type MigrationInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
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
import {validateMachineEntityRows, type MachineRow} from "./data-validation";
import type {QueryRefInfo, SnapshotSide} from "./migration-authoring";
import {inspectSchema, type InspectionScope} from "./inspect-schema";
import type {PgSchemaInfo, PgSession, ResolvedSqlResource} from "./pg-schema";
import {
    executePreparedSqlResource,
    prepareSqlResource,
    runCheckResource,
    type PreparedSqlResource,
} from "./sql-resource";
import {
    loadValidationModule,
    validationArtifactEvidenceHash,
    type ValidationArtifactHost,
    type ValidationArtifactInfo,
    type ValidationModule,
} from "./validation-artifact";

export type ReleaseExecutionState = {
    expectedSchema: PgSchemaInfo;
    inspection: InspectionScope;
    managedData: readonly ManagedDataInfo[];
    invariantChecks: readonly ResourceRefInfo[];
};

export type AuthoringCheckpointRowExecution = {
    id: string;
    afterStep: string;
    side: SnapshotSide;
    entity: string;
    select: QueryRefInfo;
    validatorArtifactHash: string;
};

export type AuthoringCheckpointExecution = {
    checkpoints: readonly {
        afterStep: string;
        checks: readonly ResourceRefInfo[];
        rows: readonly AuthoringCheckpointRowExecution[];
    }[];
    queryResources: Readonly<Record<string, {ref: QueryRefInfo; text: string}>>;
    validationArtifacts: readonly ValidationArtifactInfo[];
    validationHost: ValidationArtifactHost;
    snapshots: Readonly<Record<SnapshotSide, {snapshot: SystemSnapshotInfo; snapshotHash: string}>>;
};

export type MigrationExecutionContext = {
    journal: JournalConfig;
    scope: InstallationScope;
    resources: Readonly<Record<string, ResolvedSqlResource>>;
    from: ReleaseExecutionState;
    to: ReleaseExecutionState;
    authoring?: AuthoringCheckpointExecution;
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

type PreparedAuthoringRow = {
    id: string;
    afterStep: string;
    side: SnapshotSide;
    entity: string;
    select: {ref: QueryRefInfo; text: string};
    validatorArtifactHash: string;
    artifact: ValidationArtifactInfo;
    snapshot: SystemSnapshotInfo;
};

type PreparedAuthoringCheckpoint = {
    afterStep: string;
    checks: readonly ResolvedSqlResource[];
    rows: readonly PreparedAuthoringRow[];
};

type PreparedExecution = {
    before: readonly ResolvedSqlResource[];
    steps: readonly {id: string; resource: PreparedSqlResource}[];
    checkpoints: ReadonlyMap<string, PreparedAuthoringCheckpoint>;
    validationHost: ValidationArtifactHost | null;
    after: readonly ResolvedSqlResource[];
    targetInvariants: readonly ResolvedSqlResource[];
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}


function sameResourceRef(left: ResourceRefInfo, right: ResourceRefInfo): boolean {
    return left.name === right.name && left.kind === right.kind && left.contentHash === right.contentHash;
}

function validMilliseconds(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function validHash(value: string): boolean {
    return /^[0-9a-f]{64}$/.test(value);
}

function sameQueryRef(left: QueryRefInfo, right: QueryRefInfo): boolean {
    return left.name === right.name && left.kind === right.kind && left.contentHash === right.contentHash;
}

function prepareAuthoringCheckpoints(
    context: MigrationExecutionContext,
    stepIds: ReadonlySet<string>,
): ValidationResult<{
    checkpoints: ReadonlyMap<string, PreparedAuthoringCheckpoint>;
    validationHost: ValidationArtifactHost | null;
}> {
    const authoring = context.authoring;
    if (authoring === undefined) {
        return {ok: true, value: {checkpoints: new Map(), validationHost: null}};
    }
    if (!Array.isArray(authoring.checkpoints) || !Array.isArray(authoring.validationArtifacts)
        || authoring.queryResources === null || typeof authoring.queryResources !== "object"
        || authoring.snapshots === null || typeof authoring.snapshots !== "object"
        || authoring.validationHost === null || typeof authoring.validationHost !== "object") {
        return fail("migration.invalidReference", {reason: "invalid authoring checkpoint execution contract"});
    }

    const artifacts = new Map<string, ValidationArtifactInfo>();
    for (const artifact of authoring.validationArtifacts) {
        let evidenceHash: string;
        try {
            evidenceHash = validationArtifactEvidenceHash(artifact);
        } catch (error) {
            return fail("migration.invalidReference", {
                reason: "invalid validation artifact metadata",
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (artifacts.has(evidenceHash)) {
            return fail("migration.invalidReference", {reason: "duplicate validation artifact evidence hash", evidenceHash});
        }
        artifacts.set(evidenceHash, artifact);
    }

    const prepared = new Map<string, PreparedAuthoringCheckpoint>();
    const rowIds = new Set<string>();
    for (const checkpoint of authoring.checkpoints) {
        if (checkpoint === null || typeof checkpoint !== "object"
            || typeof checkpoint.afterStep !== "string" || checkpoint.afterStep.length === 0
            || !Array.isArray(checkpoint.checks) || !Array.isArray(checkpoint.rows)) {
            return fail("migration.invalidReference", {reason: "invalid authoring checkpoint shape"});
        }
        if (!stepIds.has(checkpoint.afterStep)) {
            return fail("migration.invalidReference", {
                reason: "authoring checkpoint references an unknown migration step",
                afterStep: checkpoint.afterStep,
            });
        }
        if (prepared.has(checkpoint.afterStep)) {
            return fail("migration.invalidReference", {
                reason: "duplicate authoring checkpoint placement",
                afterStep: checkpoint.afterStep,
            });
        }

        const checks: ResolvedSqlResource[] = [];
        for (const ref of checkpoint.checks) {
            const resolved = resolveResource(context.resources, ref, "check");
            if (!resolved.ok) return resolved;
            checks.push(resolved.value);
        }

        const rows: PreparedAuthoringRow[] = [];
        for (const row of checkpoint.rows) {
            if (row === null || typeof row !== "object"
                || typeof row.id !== "string" || row.id.length === 0
                || typeof row.afterStep !== "string"
                || (row.side !== "from" && row.side !== "to")
                || typeof row.entity !== "string" || row.entity.length === 0
                || row.select === null || typeof row.select !== "object"
                || row.select.kind !== "query"
                || typeof row.select.name !== "string" || row.select.name.length === 0
                || typeof row.select.contentHash !== "string" || !validHash(row.select.contentHash)
                || typeof row.validatorArtifactHash !== "string" || !validHash(row.validatorArtifactHash)) {
                return fail("migration.invalidReference", {reason: "invalid authoring row checkpoint shape"});
            }
            if (row.afterStep !== checkpoint.afterStep) {
                return fail("migration.invalidReference", {
                    reason: "row checkpoint afterStep does not match its checkpoint",
                    rowId: row.id,
                    afterStep: row.afterStep,
                    checkpointAfterStep: checkpoint.afterStep,
                });
            }
            if (rowIds.has(row.id)) {
                return fail("migration.invalidReference", {reason: "duplicate authoring row checkpoint id", rowId: row.id});
            }
            rowIds.add(row.id);

            const query = authoring.queryResources[row.select.name];
            if (query === undefined || query === null || typeof query !== "object"
                || typeof query.text !== "string" || !sameQueryRef(query.ref, row.select)) {
                return fail("migration.checksumMismatch", {
                    name: row.select.name,
                    reason: "resolved row query does not match the checkpoint reference",
                });
            }

            const side = row.side as SnapshotSide;
            const artifact = artifacts.get(row.validatorArtifactHash);
            if (artifact === undefined) {
                return fail("migration.invalidReference", {
                    reason: "validation artifact evidence hash is not available",
                    rowId: row.id,
                    evidenceHash: row.validatorArtifactHash,
                });
            }
            const historical = authoring.snapshots[side];
            if (historical === undefined || historical === null
                || typeof historical.snapshotHash !== "string" || !validHash(historical.snapshotHash)
                || historical.snapshot === null || typeof historical.snapshot !== "object") {
                return fail("migration.invalidReference", {
                    reason: "historical snapshot binding is missing",
                    side,
                });
            }
            if (artifact.side !== side || artifact.snapshotHash !== historical.snapshotHash) {
                return fail("migration.invalidReference", {
                    reason: "validation artifact does not match the checkpoint side/snapshot",
                    rowId: row.id,
                    side,
                });
            }
            if (historical.snapshot.entities[row.entity] === undefined) {
                return fail("migration.invalidReference", {
                    reason: "row checkpoint references an unknown historical entity",
                    rowId: row.id,
                    entity: row.entity,
                });
            }

            rows.push({
                id: row.id,
                afterStep: row.afterStep,
                side,
                entity: row.entity,
                select: query,
                validatorArtifactHash: row.validatorArtifactHash,
                artifact,
                snapshot: historical.snapshot,
            });
        }
        prepared.set(checkpoint.afterStep, {afterStep: checkpoint.afterStep, checks, rows});
    }
    return {ok: true, value: {checkpoints: prepared, validationHost: authoring.validationHost}};
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
    const authoring = prepareAuthoringCheckpoints(context, stepIds);
    if (!authoring.ok) return authoring;

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
    return {
        ok: true,
        value: {
            before,
            steps,
            checkpoints: authoring.value.checkpoints,
            validationHost: authoring.value.validationHost,
            after,
            targetInvariants,
        },
    };
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

async function queryMachineRows(
    session: PgSession,
    row: PreparedAuthoringRow,
): Promise<ValidationResult<readonly MachineRow[]>> {
    const actualHash = createHash("sha256").update(row.select.text, "utf8").digest("hex");
    if (actualHash !== row.select.ref.contentHash) {
        return fail("migration.checksumMismatch", {
            name: row.select.ref.name,
            reason: "row validation query bytes do not match the published content hash",
            expected: row.select.ref.contentHash,
            actual: actualHash,
        });
    }
    try {
        const result = await session.query(row.select.text, []);
        return {ok: true, value: result.rows as readonly MachineRow[]};
    } catch (error) {
        return fail("migration.executionFailed", {
            name: row.select.ref.name,
            reason: error instanceof Error ? error.message : "row validation query failed",
        });
    }
}

async function runAuthoringCheckpoint(
    session: PgSession,
    checkpoint: PreparedAuthoringCheckpoint,
    validationHost: ValidationArtifactHost,
    modules: Map<string, ValidationModule>,
): Promise<ValidationResult<true>> {
    const checks = await runChecks(session, checkpoint.checks);
    if (!checks.ok) return checks;

    for (const row of checkpoint.rows) {
        const queried = await queryMachineRows(session, row);
        if (!queried.ok) return queried;

        let runtime = modules.get(row.validatorArtifactHash);
        if (runtime === undefined) {
            const loaded = await loadValidationModule(row.artifact, validationHost);
            if (!loaded.ok) return loaded;
            runtime = loaded.value;
            modules.set(row.validatorArtifactHash, runtime);
        }

        const validated = validateMachineEntityRows(row.snapshot, runtime, row.entity, queried.value);
        if (!validated.ok) return validated;
    }
    return {ok: true, value: true};
}

function validatePublishedMigration(migration: PublishedMigrationInfo): ValidationResult<PublishedMigrationInfo> {
    if (migration === null || typeof migration !== "object"
        || typeof migration.migrationHash !== "string" || !/^[0-9a-f]{64}$/.test(migration.migrationHash)
        || migration.migration === null || typeof migration.migration !== "object"
        || typeof migration.migration.id !== "string" || migration.migration.id.length === 0
        || migration.migration.from.systemId !== migration.migration.to.systemId
        || sameReleaseRef(migration.migration.from, migration.migration.to)) {
        return fail("migration.invalidCatalog", {reason: "invalid published migration"});
    }
    return {ok: true, value: migration};
}


export type MigrationPreparationExecutionInfo = {
    installation: InstallationInfo;
};

export type MigrationPreparationBeforeCommit = (
    session: PgSession,
    installation: InstallationInfo,
) => Promise<ValidationResult<true>> | ValidationResult<true>;

/**
 * Runs a corrective preparation through the same atomic resource/checkpoint/schema
 * engine used by executeMigration, but deliberately does not append migration
 * history or advance the installation head. The preparation's from/to release must
 * therefore be the same confirmed head.
 */
export async function executeMigrationPreparation(
    session: PgSession,
    migration: MigrationInfo,
    context: MigrationExecutionContext,
    beforeCommit?: MigrationPreparationBeforeCommit,
): Promise<ValidationResult<MigrationPreparationExecutionInfo>> {
    if (migration === null || typeof migration !== "object"
        || typeof migration.id !== "string" || migration.id.length === 0
        || migration.from === null || typeof migration.from !== "object"
        || migration.to === null || typeof migration.to !== "object"
        || !sameReleaseRef(migration.from, migration.to)) {
        return fail("migration.invalidPreparation", {reason: "preparation must remain on the confirmed head"});
    }
    const prepared = prepareExecution(migration, context);
    if (!prepared.ok) return prepared;

    const begun = await controlQuery(session, "BEGIN");
    if (!begun.ok) return begun;
    let transactionOpen = true;

    const failInside = async <T>(result: ValidationResult<T>): Promise<ValidationResult<MigrationPreparationExecutionInfo>> => {
        if (!transactionOpen) return result as ValidationResult<MigrationPreparationExecutionInfo>;
        transactionOpen = false;
        return rollbackAfterFailure(session, result) as Promise<ValidationResult<MigrationPreparationExecutionInfo>>;
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
        if (!sameReleaseRef(installation.value.current, migration.from)) {
            return await failInside(fail("migration.headMismatch", {
                expected: migration.from.releaseId,
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

        const validationModules = new Map<string, ValidationModule>();
        for (const step of prepared.value.steps) {
            const executed = await executePreparedSqlResource(session, step.resource);
            if (!executed.ok) return await failInside(executed);

            const checkpoint = prepared.value.checkpoints.get(step.id);
            if (checkpoint !== undefined) {
                if (prepared.value.validationHost === null) {
                    return await failInside(fail("migration.invalidReference", {
                        reason: "authoring checkpoint validation host is missing",
                    }));
                }
                const checkpointResult = await runAuthoringCheckpoint(
                    session,
                    checkpoint,
                    prepared.value.validationHost,
                    validationModules,
                );
                if (!checkpointResult.ok) return await failInside(checkpointResult);
            }
        }

        const after = await runChecks(session, prepared.value.after);
        if (!after.ok) return await failInside(after);
        const invariants = await runChecks(session, prepared.value.targetInvariants);
        if (!invariants.ok) return await failInside(invariants);
        const managed = await checkManagedData(session, context.to.managedData);
        if (!managed.ok) return await failInside(managed);
        const targetSchema = await checkSchema(session, context.to, "target");
        if (!targetSchema.ok) return await failInside(targetSchema);

        if (beforeCommit !== undefined) {
            let hook: ValidationResult<true>;
            try {
                hook = await beforeCommit(session, installation.value);
            } catch (error) {
                hook = fail("migration.executionFailed", {
                    reason: error instanceof Error ? error.message : "preparation before-commit hook failed",
                });
            }
            if (!hook.ok) return await failInside(hook);
        }

        const committed = await controlQuery(session, "COMMIT");
        transactionOpen = false;
        if (!committed.ok) {
            return fail("migration.commitUnknown", {
                preparationId: migration.id,
                reason: committed.problems[0]?.details.reason ?? "commit result is unknown",
            });
        }
        return {ok: true, value: {installation: installation.value}};
    } catch (error) {
        const failure = fail<MigrationPreparationExecutionInfo>("migration.executionFailed", {
            preparationId: migration.id,
            reason: error instanceof Error ? error.message : "preparation execution threw",
        });
        if (!transactionOpen) return failure;
        transactionOpen = false;
        return rollbackAfterFailure(session, failure);
    }
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
        if (!sameReleaseRef(installation.value.current, migration.migration.from)) {
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

        const validationModules = new Map<string, ValidationModule>();
        for (const step of prepared.value.steps) {
            const executed = await executePreparedSqlResource(session, step.resource);
            if (!executed.ok) return await failInside(executed);

            const checkpoint = prepared.value.checkpoints.get(step.id);
            if (checkpoint !== undefined) {
                if (prepared.value.validationHost === null) {
                    return await failInside(fail("migration.invalidReference", {
                        reason: "authoring checkpoint validation host is missing",
                    }));
                }
                const checkpointResult = await runAuthoringCheckpoint(
                    session,
                    checkpoint,
                    prepared.value.validationHost,
                    validationModules,
                );
                if (!checkpointResult.ok) return await failInside(checkpointResult);
            }
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

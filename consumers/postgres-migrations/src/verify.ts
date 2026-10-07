import {
    hasExactKeys,
    problem,
    sameReleaseRef,
    type MigrationPathInfo,
    type PersistenceInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import {compareSchemas} from "./compare-schema";
import {prepareCreateResources, validateExpectedObjects} from "./create-resources";
import type {MigrationExecutionContext} from "./execute-migration";
import {generateCreate} from "./generate-create";
import {
    bootstrapJournal,
    installBaseline,
    type InstallationScope,
    type JournalConfig,
} from "./journal";
import {checkManagedData} from "./managed-data";
import {inspectSchema, type InspectionInfo, type InspectionScope} from "./inspect-schema";
import {pgIdentityKey} from "./pg-identity";
import {
    projectSchema,
    type CreateResourceInfo,
    type PgObjectIdentity,
    type PgObjectInfo,
    type PgSchemaInfo,
    type PgSession,
    type ResolvedSqlResource,
    type StorageContext,
} from "./pg-schema";
import {executeMigrationPath} from "./runner";
import {
    executePreparedSqlResource,
    prepareSqlResource,
    runCheckResource,
} from "./sql-resource";

export type ScratchHandle = {
    id: string;
    session: PgSession;
};

export type ScratchProvider = {
    create(purpose: "clean-target" | "upgrade-source"): Promise<ValidationResult<ScratchHandle>>;
    owns(handle: ScratchHandle): boolean;
    destroy(handle: ScratchHandle): Promise<ValidationResult<true>>;
};

export type ReleaseVerificationInput = {
    ref: ReleaseRefInfo;
    snapshot: SystemSnapshotInfo;
    persistence: PersistenceInfo;
    storage: StorageContext;
    inspection: InspectionScope;
};

export type UpgradeVerificationInput = {
    source: ReleaseVerificationInput;
    target: ReleaseVerificationInput;
    path: MigrationPathInfo;
    journal: JournalConfig;
    scope: InstallationScope;
    fixture: {
        id: string;
        load(session: PgSession): Promise<ValidationResult<true>>;
        verify(session: PgSession): Promise<ValidationResult<true>>;
    };
    resolveContext(migration: PublishedMigrationInfo): MigrationExecutionContext;
};

export type UpgradeVerificationInfo = {
    cleanTarget: PgSchemaInfo;
    upgradedTarget: PgSchemaInfo;
    fixtureId: string;
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}


function sameResourceRef(
    left: {name: string; kind: "sql" | "check"; contentHash: string},
    right: {name: string; kind: "sql" | "check"; contentHash: string},
): boolean {
    return left.name === right.name && left.kind === right.kind && left.contentHash === right.contentHash;
}

function validScratchHandle(value: unknown): value is ScratchHandle {
    return typeof value === "object" && value !== null
        && hasExactKeys(value, ["id", "session"])
        && typeof (value as {id?: unknown}).id === "string"
        && (value as {id: string}).id.length > 0
        && typeof (value as {session?: unknown}).session === "object"
        && (value as {session: unknown}).session !== null
        && typeof (value as {session: {query?: unknown}}).session.query === "function"
        && typeof (value as {session: {close?: unknown}}).session.close === "function";
}

function validReleaseInput(value: unknown): value is ReleaseVerificationInput {
    return typeof value === "object" && value !== null
        && hasExactKeys(value, ["ref", "snapshot", "persistence", "storage", "inspection"]);
}

function validUpgradeInput(value: unknown): value is UpgradeVerificationInput {
    if (typeof value !== "object" || value === null
        || !hasExactKeys(value, ["source", "target", "path", "journal", "scope", "fixture", "resolveContext"])) {
        return false;
    }
    const input = value as UpgradeVerificationInput;
    return validReleaseInput(input.source)
        && validReleaseInput(input.target)
        && typeof input.fixture === "object" && input.fixture !== null
        && hasExactKeys(input.fixture, ["id", "load", "verify"])
        && typeof input.fixture.id === "string" && input.fixture.id.length > 0
        && typeof input.fixture.load === "function"
        && typeof input.fixture.verify === "function"
        && typeof input.resolveContext === "function";
}


function authoredObjectKeys(resources: readonly CreateResourceInfo[]): ReadonlySet<string> {
    const result = new Set<string>();
    for (const resource of resources) {
        for (const object of resource.expectedObjects) result.add(pgIdentityKey(object));
    }
    return result;
}

function projectionRelevantInspection(
    inspection: InspectionInfo,
    createResources: readonly CreateResourceInfo[],
): InspectionInfo {
    const authored = authoredObjectKeys(createResources);
    const objects = inspection.schema.objects.filter((object): boolean => {
        if (authored.has(pgIdentityKey(object.identity))) return false;
        if (object.kind === "index" && object.ownerConstraint !== null) return false;
        return true;
    });
    return {
        schema: {...inspection.schema, objects},
        unknown: inspection.unknown,
        excluded: inspection.excluded,
    };
}

async function safeQuery(
    session: PgSession,
    text: string,
    values: readonly (null | boolean | number | string | Uint8Array)[],
): Promise<ValidationResult<true>> {
    try {
        await session.query(text, values);
        return {ok: true, value: true};
    } catch (error) {
        return fail("migration.executionFailed", {
            reason: error instanceof Error ? error.message : "scratch SQL execution failed",
        });
    }
}

async function runInvariantChecks(
    session: PgSession,
    storage: StorageContext,
): Promise<ValidationResult<true>> {
    for (const ref of storage.invariantChecks) {
        if (ref.kind !== "check") {
            return fail("migration.invalidResourceKind", {name: ref.name, expected: "check"});
        }
        const resource = storage.resources[ref.name];
        if (resource === undefined
            || resource.ref.name !== ref.name
            || resource.ref.kind !== ref.kind
            || resource.ref.contentHash !== ref.contentHash) {
            return fail("migration.checksumMismatch", {name: ref.name});
        }
        const checked = await runCheckResource(session, resource);
        if (!checked.ok) return checked;
    }
    return {ok: true, value: true};
}

async function executeCreateResources(
    session: PgSession,
    storage: StorageContext,
    resources: readonly CreateResourceInfo[],
): Promise<ValidationResult<true>> {
    for (const declared of resources) {
        const resolved = storage.resources[declared.run.name];
        if (resolved === undefined) {
            return fail("migration.invalidReference", {name: declared.run.name});
        }
        const prepared = prepareSqlResource(resolved);
        if (!prepared.ok) return prepared;
        const executed = await executePreparedSqlResource(session, prepared.value);
        if (!executed.ok) return executed;
    }
    return {ok: true, value: true};
}

async function inspectAndValidateRelease(
    session: PgSession,
    release: ReleaseVerificationInput,
    expected: PgSchemaInfo,
    createResources: readonly CreateResourceInfo[],
): Promise<ValidationResult<true>> {
    const inspected = await inspectSchema(session, release.inspection);
    if (!inspected.ok) return inspected;

    const authored = validateExpectedObjects(createResources, inspected.value);
    if (!authored.ok) return authored;

    const compared = compareSchemas(expected, projectionRelevantInspection(inspected.value, createResources));
    if (!compared.ok) return compared;
    if (!compared.value.equal) {
        const first = compared.value.differences[0];
        return fail("migration.schemaDrift", {
            releaseId: release.ref.releaseId,
            path: first === undefined ? "schema" : first.path.join("."),
            differenceCount: String(compared.value.differences.length),
        });
    }

    const managed = await checkManagedData(session, release.storage.managedData);
    if (!managed.ok) return managed;
    return runInvariantChecks(session, release.storage);
}

async function buildReleaseOnScratch(
    session: PgSession,
    release: ReleaseVerificationInput,
): Promise<ValidationResult<PgSchemaInfo>> {
    const projected = projectSchema(release.snapshot, release.persistence, release.storage);
    if (!projected.ok) return projected;

    const generated = generateCreate(projected.value);
    if (!generated.ok) return generated;
    for (const statement of generated.value.statements) {
        const executed = await safeQuery(session, statement.text, statement.values);
        if (!executed.ok) return executed;
    }

    const createResources = prepareCreateResources(release.storage);
    if (!createResources.ok) return createResources;
    const extra = await executeCreateResources(session, release.storage, createResources.value);
    if (!extra.ok) return extra;

    const verified = await inspectAndValidateRelease(
        session,
        release,
        projected.value,
        createResources.value,
    );
    if (!verified.ok) return verified;
    return {ok: true, value: projected.value};
}

async function destroyOwned(
    provider: ScratchProvider,
    handle: ScratchHandle,
): Promise<ValidationResult<true>> {
    try {
        return await provider.destroy(handle);
    } catch (error) {
        return fail("migration.executionFailed", {
            scratchId: handle.id,
            reason: error instanceof Error ? error.message : "scratch cleanup failed",
        });
    }
}

async function withOwnedScratch<T>(
    provider: ScratchProvider,
    purpose: "clean-target" | "upgrade-source",
    body: (handle: ScratchHandle) => Promise<ValidationResult<T>>,
): Promise<ValidationResult<T>> {
    let created: ValidationResult<ScratchHandle>;
    try {
        created = await provider.create(purpose);
    } catch (error) {
        return fail("migration.executionFailed", {
            reason: error instanceof Error ? error.message : "scratch creation failed",
        });
    }
    if (!created.ok) return created;
    const handle = created.value;
    if (!validScratchHandle(handle)) {
        return fail("migration.invalidReference", {reason: "scratch provider returned an invalid handle"});
    }

    let owned = false;
    try {
        owned = provider.owns(handle);
    } catch {
        owned = false;
    }
    if (!owned) {
        return fail("migration.invalidReference", {
            scratchId: handle.id,
            reason: "scratch handle is not owned by its provider",
        });
    }

    let result: ValidationResult<T>;
    try {
        result = await body(handle);
    } catch (error) {
        result = fail("migration.executionFailed", {
            scratchId: handle.id,
            reason: error instanceof Error ? error.message : "scratch verification failed",
        });
    }

    const cleanup = await destroyOwned(provider, handle);
    if (cleanup.ok) return result;
    if (result.ok) return cleanup as ValidationResult<T>;
    return {ok: false, problems: [...result.problems, ...cleanup.problems]};
}


async function replayDataProofAfterSchemaDrift(
    session: PgSession,
    input: UpgradeVerificationInput,
): Promise<ValidationResult<true>> {
    const begun = await safeQuery(session, "BEGIN", []);
    if (!begun.ok) return begun;
    let open = true;
    const rollback = async <T>(result: ValidationResult<T>): Promise<ValidationResult<T>> => {
        if (!open) return result;
        open = false;
        await safeQuery(session, "ROLLBACK", []);
        return result;
    };
    try {
        for (const published of input.path.migrations) {
            let context: MigrationExecutionContext;
            try {
                context = input.resolveContext(published);
            } catch (error) {
                return rollback(fail("migration.executionFailed", {
                    migrationId: published.migration.id,
                    reason: error instanceof Error ? error.message : "migration execution context resolution failed",
                }));
            }
            for (const ref of published.migration.before) {
                const resource = context.resources[ref.name];
                if (ref.kind !== "check" || resource === undefined || !sameResourceRef(ref, resource.ref)) {
                    return rollback(fail("migration.invalidReference", {name: ref.name}));
                }
                const checked = await runCheckResource(session, resource);
                if (!checked.ok) return rollback(checked);
            }
            for (const step of published.migration.steps) {
                const resource = context.resources[step.run.name];
                if (step.run.kind !== "sql" || resource === undefined || !sameResourceRef(step.run, resource.ref)) {
                    return rollback(fail("migration.invalidReference", {name: step.run.name}));
                }
                const prepared = prepareSqlResource(resource);
                if (!prepared.ok) return rollback(prepared);
                const executed = await executePreparedSqlResource(session, prepared.value);
                if (!executed.ok) return rollback(executed);
            }
            for (const ref of published.migration.after) {
                const resource = context.resources[ref.name];
                if (ref.kind !== "check" || resource === undefined || !sameResourceRef(ref, resource.ref)) {
                    return rollback(fail("migration.invalidReference", {name: ref.name}));
                }
                const checked = await runCheckResource(session, resource);
                if (!checked.ok) return rollback(checked);
            }
        }
        const committed = await safeQuery(session, "COMMIT", []);
        open = false;
        return committed;
    } catch (error) {
        return rollback(fail("migration.executionFailed", {
            reason: error instanceof Error ? error.message : "diagnostic scratch replay failed",
        }));
    }
}
export async function verifyRelease(
    release: ReleaseVerificationInput,
    scratch: ScratchProvider,
): Promise<ValidationResult<PgSchemaInfo>> {
    if (!validReleaseInput(release) || typeof scratch !== "object" || scratch === null
        || typeof scratch.create !== "function" || typeof scratch.owns !== "function" || typeof scratch.destroy !== "function") {
        return fail("migration.invalidReference", {reason: "invalid release verification input or scratch provider"});
    }
    if (release.snapshot.systemId !== release.ref.systemId) {
        return fail("migration.invalidReference", {reason: "release reference system does not match snapshot"});
    }
    return withOwnedScratch(scratch, "clean-target", async handle => buildReleaseOnScratch(handle.session, release));
}

function validateUpgradeReferences(input: UpgradeVerificationInput): ValidationResult<true> {
    if (input.source.snapshot.systemId !== input.source.ref.systemId
        || input.target.snapshot.systemId !== input.target.ref.systemId
        || input.source.ref.systemId !== input.target.ref.systemId
        || !sameReleaseRef(input.path.from, input.source.ref)
        || !sameReleaseRef(input.path.to, input.target.ref)
        || input.scope.systemId !== input.source.ref.systemId) {
        return fail("migration.invalidReference", {reason: "upgrade source/target/path/scope references do not agree"});
    }
    return {ok: true, value: true};
}

export async function verifyUpgrade(
    input: UpgradeVerificationInput,
    scratch: ScratchProvider,
): Promise<ValidationResult<UpgradeVerificationInfo>> {
    if (!validUpgradeInput(input)) {
        return fail("migration.invalidReference", {reason: "invalid upgrade verification input"});
    }
    const references = validateUpgradeReferences(input);
    if (!references.ok) return references;

    const cleanTarget = await verifyRelease(input.target, scratch);
    if (!cleanTarget.ok) return cleanTarget;

    return withOwnedScratch(scratch, "upgrade-source", async handle => {
        const sourceBuilt = await buildReleaseOnScratch(handle.session, input.source);
        if (!sourceBuilt.ok) return sourceBuilt;

        const bootstrapped = await bootstrapJournal(handle.session, input.journal);
        if (!bootstrapped.ok) return bootstrapped;
        const baseline = await installBaseline(handle.session, input.journal, {
            installationId: "verify-" + handle.id,
            scope: input.scope,
            baseline: input.source.ref,
        });
        if (!baseline.ok) return baseline;

        let loaded: ValidationResult<true>;
        try {
            loaded = await input.fixture.load(handle.session);
        } catch (error) {
            return fail("migration.executionFailed", {
                fixture: input.fixture.id,
                reason: error instanceof Error ? error.message : "fixture load failed",
            });
        }
        if (!loaded.ok) return loaded;

        const migrated = await executeMigrationPath(handle.session, input.path, async migration => {
            try {
                const context = input.resolveContext(migration);
                return {ok: true as const, value: context};
            } catch (error) {
                return fail<MigrationExecutionContext>("migration.executionFailed", {
                    migrationId: migration.migration.id,
                    reason: error instanceof Error ? error.message : "migration execution context resolution failed",
                });
            }
        });
        if (!migrated.ok) {
            if (migrated.problems[0]?.messageKey === "migration.schemaDrift") {
                // The transactional runner correctly rolls the failed candidate back. On scratch only,
                // replay the same preflighted resources once from that restored origin to prove the
                // data/check route independently; the original structural drift remains authoritative.
                // No journal confirmation is written and the owned scratch is destroyed immediately.
                const dataProof = await replayDataProofAfterSchemaDrift(handle.session, input);
                if (dataProof.ok) {
                    try {
                        const fixtureProof = await input.fixture.verify(handle.session);
                        if (!fixtureProof.ok) {
                            return {ok: false, problems: [...migrated.problems, ...fixtureProof.problems]};
                        }
                    } catch (error) {
                        return {
                            ok: false,
                            problems: [...migrated.problems, problem(null, "migration.executionFailed", "blocking", {
                                fixture: input.fixture.id,
                                reason: error instanceof Error ? error.message : "fixture verification failed",
                            })],
                        };
                    }
                } else {
                    return {ok: false, problems: [...migrated.problems, ...dataProof.problems]};
                }
            }
            return migrated;
        }

        let fixtureVerified: ValidationResult<true>;
        try {
            fixtureVerified = await input.fixture.verify(handle.session);
        } catch (error) {
            return fail("migration.executionFailed", {
                fixture: input.fixture.id,
                reason: error instanceof Error ? error.message : "fixture verification failed",
            });
        }
        if (!fixtureVerified.ok) return fixtureVerified;

        const targetProjection = projectSchema(input.target.snapshot, input.target.persistence, input.target.storage);
        if (!targetProjection.ok) return targetProjection;
        const targetResources = prepareCreateResources(input.target.storage);
        if (!targetResources.ok) return targetResources;
        const targetVerified = await inspectAndValidateRelease(
            handle.session,
            input.target,
            targetProjection.value,
            targetResources.value,
        );
        if (!targetVerified.ok) return targetVerified;

        return {
            ok: true,
            value: {
                cleanTarget: cleanTarget.value,
                upgradedTarget: targetProjection.value,
                fixtureId: input.fixture.id,
            },
        };
    });
}

import {
    problem,
    sameReleaseRef,
    type MigrationInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {
    AuthoringRuntime,
    CompiledAuthoringInfo,
    ManualStepInfo,
    MigrationDraftInfo,
    RenameInfo,
    StructureChangeInfo,
} from "./authoring-contract";
import {compileGenerated} from "./compile-generated";
import {inferStructureChanges} from "./infer";
import {pgIdentityKey, samePgIdentity} from "./pg-identity";
import type {PgObjectIdentity, PgObjectInfo, PgSchemaInfo} from "./pg-schema";
import {prepareManualSqlResource} from "./sql-resource";
import {validateMigrationDecisions} from "./migration-decisions";
import {deduplicateMigrationChecks} from "./check-references";
import {orderDependencies, dependencyReachability} from "./dependency-order";
import {isFieldRename} from "./authoring-contract";

export * from "./authoring-contract";

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}


function hasField(schema: PgSchemaInfo, entity: string, field: string): boolean {
    return schema.objects.some((object: PgObjectInfo): boolean => object.kind === "column"
        && object.identity.parentName === entity
        && object.identity.name === field);
}

function hasEntity(schema: PgSchemaInfo, entity: string): boolean {
    return schema.objects.some((object: PgObjectInfo): boolean => object.kind === "table"
        && object.identity.name === entity);
}

/**
 * Once authored effects have been replayed, an explicit rename that is already
 * visible at its destination is no longer residual work.  Renames whose source
 * still exists remain correspondence hints for the residual inference pass.
 */
function residualRenames(
    inspected: PgSchemaInfo,
    desired: PgSchemaInfo,
    renames: readonly RenameInfo[],
): readonly RenameInfo[] {
    return renames.filter((rename): boolean => {
        if (isFieldRename(rename)) {
            const before = rename.before;
            const after = rename.after;
            if (!hasField(desired, after.entity, after.field)) return true;
            if (hasField(inspected, before.entity, before.field)) return true;
            return !hasField(inspected, after.entity, after.field);
        }
        const before = rename.before.entity;
        const after = rename.after.entity;
        if (!hasEntity(desired, after)) return true;
        if (hasEntity(inspected, before)) return true;
        return !hasEntity(inspected, after);
    });
}

function hasIdentity(schema: PgSchemaInfo, identity: PgObjectIdentity): boolean {
    return schema.objects.some(object => samePgIdentity(object.identity, identity));
}

type ValidatedManualInfo = {
    steps: readonly ManualStepInfo[];
    claimedChangeIds: ReadonlySet<string>;
    before: readonly ResourceRefInfo[];
    checkpoints: CompiledAuthoringInfo["checkpoints"];
};

function orderedManualSteps(manual: readonly ManualStepInfo[]): ValidationResult<readonly ManualStepInfo[]> {
    const byId = new Map(manual.map(step => [step.id, step] as const));

    for (const step of manual) {
        const seen = new Set<string>();
        for (const dependency of step.dependsOn) {
            if (!byId.has(dependency)) {
                return fail("migration.invalidReference", {
                    stepId: step.id,
                    dependsOn: dependency,
                    reason: "manual dependency references an unknown step",
                });
            }
            if (seen.has(dependency)) {
                return fail("migration.authoringInvalid", {
                    stepId: step.id,
                    dependsOn: dependency,
                    reason: "manual dependency is declared more than once",
                });
            }
            seen.add(dependency);
        }
    }

    const ordered = orderDependencies(manual);
    if (ordered === null) {
        return fail("migration.authoringInvalid", {
            reason: "manual dependency graph contains a cycle",
        });
    }
    return {ok: true, value: ordered};
}


function validateManualWriterOrder(steps: readonly ManualStepInfo[]): ValidationResult<true> {
    const reaches = dependencyReachability(steps);
    for (let leftIndex = 0; leftIndex < steps.length; leftIndex++) {
        const left = steps[leftIndex] as ManualStepInfo;
        const leftMutations = new Set([...left.writes, ...left.destroys].map(pgIdentityKey));
        if (leftMutations.size === 0) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < steps.length; rightIndex++) {
            const right = steps[rightIndex] as ManualStepInfo;
            const overlaps = [...right.writes, ...right.destroys].some(identity => leftMutations.has(pgIdentityKey(identity)));
            if (!overlaps) continue;
            const ordered = reaches(left.id, right.id)
                || reaches(right.id, left.id);
            if (!ordered) {
                return fail("migration.authoringInvalid", {
                    firstStepId: left.id,
                    secondStepId: right.id,
                    reason: "manual writers overlap without an explicit dependency order",
                });
            }
        }
    }
    return {ok: true, value: true};
}

function manualCheckpoints(steps: readonly ManualStepInfo[]): Pick<MigrationInfo, "before"> & Pick<CompiledAuthoringInfo, "checkpoints"> {
    if (steps.length === 0) return {before: [], checkpoints: []};

    const before = [...(steps[0]?.before ?? [])];
    const checkpoints: CompiledAuthoringInfo["checkpoints"][number][] = [];
    for (let index = 0; index < steps.length; index++) {
        const current = steps[index] as ManualStepInfo;
        const next = steps[index + 1];
        const checks = [
            ...current.after,
            ...(next?.before ?? []),
        ];
        if (checks.length > 0) {
            checkpoints.push({afterStep: current.id, checks, rows: []});
        }
    }
    return {before, checkpoints};
}

async function validateManualSteps(
    desired: PgSchemaInfo,
    manual: readonly ManualStepInfo[],
    runtime: Pick<AuthoringRuntime, "readSql" | "emitResource">,
): Promise<ValidationResult<ValidatedManualInfo>> {
    const stepIds = new Set<string>();
    for (const step of manual) {
        if (step.id.length === 0 || stepIds.has(step.id)) {
            return fail("migration.authoringInvalid", {
                stepId: step.id,
                reason: "manual step ids must be non-empty and unique",
            });
        }
        stepIds.add(step.id);
    }

    const ordered = orderedManualSteps(manual);
    if (!ordered.ok) return ordered;
    const writerOrder = validateManualWriterOrder(ordered.value);
    if (!writerOrder.ok) return writerOrder;

    for (const step of ordered.value) {
        if (step.before.some(ref => ref.kind !== "check") || step.after.some(ref => ref.kind !== "check")) {
            return fail("migration.invalidResourceKind", {
                stepId: step.id,
                reason: "manual before/after resources must be checks",
            });
        }
        if (step.rowChecks.length > 0) {
            return fail("migration.authoringPending", {
                stepId: step.id,
                reason: "manual row checks require query/artifact integration in T22",
            });
        }

        for (const identity of step.writes) {
            if (!hasIdentity(desired, identity)) {
                return fail("migration.authoringInvalid", {
                    stepId: step.id,
                    reason: "manual write is outside desired SSOT",
                });
            }
        }
        for (const identity of step.destroys) {
            if (hasIdentity(desired, identity)) {
                return fail("migration.authoringInvalid", {
                    stepId: step.id,
                    reason: "manual destroy contradicts desired SSOT",
                });
            }
        }

    }

    for (const step of ordered.value) {
        if (runtime.readSql === undefined) {
            return fail("migration.invalidReference", {
                stepId: step.id,
                reason: "authoring runtime cannot resolve handwritten SQL",
            });
        }
        const sql = await runtime.readSql(step.run);
        if (!sql.ok) return sql;
        const prepared = prepareManualSqlResource({ref: step.run, text: sql.value});
        if (!prepared.ok) return prepared;
        if (runtime.emitResource) {
            const emitted = await runtime.emitResource({ref: step.run, text: sql.value});
            if (!emitted.ok) return emitted;
        }
    }

    const checkpoints = manualCheckpoints(ordered.value);
    return {
        ok: true,
        value: {
            steps: ordered.value,
            claimedChangeIds: new Set(ordered.value.flatMap(step => step.implementsChanges)),
            before: checkpoints.before,
            checkpoints: checkpoints.checkpoints,
        },
    };
}

function unsupported(change: StructureChangeInfo): ValidationResult<never> {
    return fail("migration.unsupportedSchemaFeature", {
        changeId: change.id,
        action: change.action,
        reason: "residual structure is outside automatic generation coverage",
    });
}

function migrationForDraft(
    draft: MigrationDraftInfo,
    manual: ValidatedManualInfo,
): MigrationInfo {
    return {
        id: draft.id,
        from: draft.base.from,
        to: draft.base.to,
        description: "",
        before: [...manual.before, ...draft.decisions.flatMap(decision => decision.resolution.kind === "check" ? [decision.resolution.run] : [])],
        steps: manual.steps.map(step => ({id: step.id, run: step.run})),
        after: [],
    };
}

async function prepareAssembly(draft: MigrationDraftInfo, changes: readonly StructureChangeInfo[], desired: PgSchemaInfo, runtime: Pick<AuthoringRuntime, "readSql" | "emitResource">): Promise<ValidationResult<{manual: ValidatedManualInfo; initial: CompiledAuthoringInfo}>> {
    const decisions = validateMigrationDecisions(changes, draft);
    if (!decisions.ok) return decisions;
    const manual = await validateManualSteps(desired, draft.manual, runtime);
    if (!manual.ok) return manual;
    return {ok: true, value: {manual: manual.value, initial: deduplicateMigrationChecks({
        formatVersion: 1, draftHash: draft.revisionHash, base: draft.base,
        migration: migrationForDraft(draft, manual.value), decisions: draft.decisions,
        operations: manual.value.steps.map(step => ({id: "manual:" + step.id, stepIds: [step.id], changeIds: [...step.implementsChanges], dataMigrationIds: []})),
        checkpoints: manual.value.checkpoints, queryResources: {}, validationArtifacts: [],
    })}};
}

/** Assemble from supplied schemas and declared effects; verification is a separate step. */
export async function assembleMigration(draft: MigrationDraftInfo, current: PgSchemaInfo, desired: PgSchemaInfo, runtime: Pick<AuthoringRuntime, "readQuery" | "readSql" | "emitResource" | "loadDataContext" | "finalSteps">): Promise<ValidationResult<CompiledAuthoringInfo>> {
    const changes = inferStructureChanges(draft.base, current, desired, draft.renames);
    if (!changes.ok) return changes;
    const prepared = await prepareAssembly(draft, changes.value, desired, runtime);
    if (!prepared.ok) return prepared;
    const residual = changes.value.filter(change => !prepared.value.manual.claimedChangeIds.has(change.id));
    return compileGenerated(draft, runtime, current, desired, residual, prepared.value.initial);
}

/**
 * Compile the structural, data and manual portions of an authoring draft.
 *
 * The historical reconstruction, desired SSOT release and inspected authored
 * result are intentionally three separate authorities.  Derived draft.changes
 * is never trusted: the residual is inferred again from inspected -> desired.
 */
export async function compileDraft(
    draft: MigrationDraftInfo,
    runtime: AuthoringRuntime,
): Promise<ValidationResult<CompiledAuthoringInfo>> {
    if (draft.formatVersion !== 1 || draft.id.length === 0 || draft.revisionHash.length === 0) {
        return fail("migration.unsupportedFormat", {reason: "invalid authoring draft"});
    }
    const reconstructed = await runtime.reconstructHistory(draft.base.from);
    if (!reconstructed.ok) return reconstructed;

    const loadedDesired = await runtime.loadRelease(draft.base.to);
    if (!loadedDesired.ok) return loadedDesired;
    if (!sameReleaseRef(loadedDesired.value.ref, draft.base.to)) {
        return fail("migration.invalidReference", {
            expectedReleaseId: draft.base.to.releaseId,
            actualReleaseId: loadedDesired.value.ref.releaseId,
            reason: "loaded desired release does not match draft base.to",
        });
    }

    // Validate the historical correspondence/rename declarations without using
    // draft.changes as authority for what still has to be done.
    const historical = inferStructureChanges(
        draft.base,
        reconstructed.value,
        loadedDesired.value.expectedSchema,
        draft.renames,
    );
    if (!historical.ok) return historical;

    const prepared = await prepareAssembly(draft, historical.value, loadedDesired.value.expectedSchema, runtime);
    if (!prepared.ok) return prepared;
    const {manual, initial} = prepared.value;

    const inspected = await runtime.inspectDraft({...draft, manual: manual.steps});
    if (!inspected.ok) return inspected;

    const residual = inferStructureChanges(
        draft.base,
        inspected.value,
        loadedDesired.value.expectedSchema,
        residualRenames(inspected.value, loadedDesired.value.expectedSchema, draft.renames),
    );
    if (!residual.ok) return residual;

    const repeatedManualChange = residual.value.find(change => manual.claimedChangeIds.has(change.id));
    if (repeatedManualChange !== undefined) {
        return fail("migration.authoringInvalid", {
            changeId: repeatedManualChange.id,
            reason: "manual step claimed a change that remains after replay",
        });
    }

    const firstUnsupported = residual.value.find(change => change.impact === "unsupported");
    if (firstUnsupported !== undefined) return unsupported(firstUnsupported);

    const assembled = await compileGenerated(draft, runtime, inspected.value, loadedDesired.value.expectedSchema, residual.value, initial);
    if (!assembled.ok) return assembled;
    if (assembled.value === initial) return assembled;
    if (!runtime.inspectCompiled) return fail("migration.authoringInvalid", {reason: "Verification requires owned scratch replay"});
    const replayed = await runtime.inspectCompiled(assembled.value);
    if (!replayed.ok) return replayed;
    const remaining = inferStructureChanges(draft.base, replayed.value, loadedDesired.value.expectedSchema, []);
    if (!remaining.ok) return remaining;
    return remaining.value.length === 0 ? assembled : fail("migration.authoringInvalid", {reason: "Combined SQL replay did not reach the requested SSOT"});
}

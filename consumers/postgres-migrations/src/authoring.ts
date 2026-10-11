import {
    problem,
    sameReleaseRef,
    type MigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {
    AuthoringRuntime,
    CompiledAuthoringInfo,
    CompiledAuthoringOperationInfo,
    FieldRefInfo,
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
import {assessMigrationDecisions} from "./migration-decisions";

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

type FieldRenameInfo = RenameInfo & {before: FieldRefInfo; after: FieldRefInfo};

function isFieldRename(rename: RenameInfo): rename is FieldRenameInfo {
    return Object.prototype.hasOwnProperty.call(rename.before, "field")
        && Object.prototype.hasOwnProperty.call(rename.after, "field");
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
    checkpoints: readonly {afterStep: string; checks: readonly ResourceRefInfo[]; rows: readonly unknown[]}[];
};

function manualEffectCoversChange(step: ManualStepInfo, change: StructureChangeInfo): boolean {
    if (change.action === "add" && change.after !== null) {
        return step.writes.some(identity => samePgIdentity(identity, change.after as PgObjectIdentity));
    }
    if (change.action === "remove" && change.before !== null) {
        return step.destroys.some(identity => samePgIdentity(identity, change.before as PgObjectIdentity));
    }
    return true;
}


function orderedManualSteps(manual: readonly ManualStepInfo[]): ValidationResult<readonly ManualStepInfo[]> {
    const byId = new Map(manual.map(step => [step.id, step] as const));
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

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
            const targets = dependents.get(dependency) ?? [];
            targets.push(step.id);
            dependents.set(dependency, targets);
        }
        indegree.set(step.id, seen.size);
    }

    const ready = [...manual]
        .filter(step => (indegree.get(step.id) ?? 0) === 0)
        .map(step => step.id)
        .sort();
    const ordered: ManualStepInfo[] = [];

    while (ready.length > 0) {
        const id = ready.shift() as string;
        const step = byId.get(id);
        if (step === undefined) continue;
        ordered.push(step);
        for (const dependent of [...(dependents.get(id) ?? [])].sort()) {
            const next = (indegree.get(dependent) ?? 0) - 1;
            indegree.set(dependent, next);
            if (next === 0) {
                ready.push(dependent);
                ready.sort();
            }
        }
    }

    if (ordered.length !== manual.length) {
        return fail("migration.authoringInvalid", {
            reason: "manual dependency graph contains a cycle",
        });
    }
    return {ok: true, value: ordered};
}

function transitivelyDependsOn(
    stepId: string,
    dependencyId: string,
    byId: ReadonlyMap<string, ManualStepInfo>,
    memo: Map<string, ReadonlySet<string>>,
): boolean {
    const cached = memo.get(stepId);
    if (cached !== undefined) return cached.has(dependencyId);

    const found = new Set<string>();
    const stack = [...(byId.get(stepId)?.dependsOn ?? [])];
    while (stack.length > 0) {
        const current = stack.pop() as string;
        if (found.has(current)) continue;
        found.add(current);
        stack.push(...(byId.get(current)?.dependsOn ?? []));
    }
    memo.set(stepId, found);
    return found.has(dependencyId);
}

function validateManualWriterOrder(steps: readonly ManualStepInfo[]): ValidationResult<true> {
    const byId = new Map(steps.map(step => [step.id, step] as const));
    const memo = new Map<string, ReadonlySet<string>>();
    for (let leftIndex = 0; leftIndex < steps.length; leftIndex++) {
        const left = steps[leftIndex] as ManualStepInfo;
        const leftMutations = new Set([...left.writes, ...left.destroys].map(pgIdentityKey));
        if (leftMutations.size === 0) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < steps.length; rightIndex++) {
            const right = steps[rightIndex] as ManualStepInfo;
            const overlaps = [...right.writes, ...right.destroys].some(identity => leftMutations.has(pgIdentityKey(identity)));
            if (!overlaps) continue;
            const ordered = transitivelyDependsOn(left.id, right.id, byId, memo)
                || transitivelyDependsOn(right.id, left.id, byId, memo);
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

function manualCheckpoints(steps: readonly ManualStepInfo[]): {
    before: readonly ResourceRefInfo[];
    checkpoints: readonly {afterStep: string; checks: readonly ResourceRefInfo[]; rows: readonly unknown[]}[];
} {
    if (steps.length === 0) return {before: [], checkpoints: []};

    const before = [...(steps[0]?.before ?? [])];
    const checkpoints: {afterStep: string; checks: readonly ResourceRefInfo[]; rows: readonly unknown[]}[] = [];
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
    changes: readonly StructureChangeInfo[],
    desired: PgSchemaInfo,
    manual: readonly ManualStepInfo[],
    runtime: AuthoringRuntime,
): Promise<ValidationResult<ValidatedManualInfo>> {
    const changeById = new Map(changes.map(change => [change.id, change] as const));
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

    const claimedChangeIds = new Set<string>();
    for (const step of ordered.value) {
        if (step.run.kind !== "sql") {
            return fail("migration.invalidResourceKind", {
                stepId: step.id,
                expected: "sql",
                actual: step.run.kind,
            });
        }
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

        for (const changeId of step.implementsChanges) {
            const change = changeById.get(changeId);
            if (change === undefined) {
                return fail("migration.invalidReference", {
                    stepId: step.id,
                    changeId,
                    reason: "manual step claims a change outside the reconstructed diff",
                });
            }
            if (claimedChangeIds.has(changeId)) {
                return fail("migration.authoringInvalid", {
                    stepId: step.id,
                    changeId,
                    reason: "structure change is claimed by more than one manual step",
                });
            }
            if (!manualEffectCoversChange(step, change)) {
                return fail("migration.authoringInvalid", {
                    stepId: step.id,
                    changeId,
                    reason: "manual effect contract does not cover the claimed structure change",
                });
            }
            claimedChangeIds.add(changeId);
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
    }

    const checkpoints = manualCheckpoints(ordered.value);
    return {
        ok: true,
        value: {
            steps: ordered.value,
            claimedChangeIds,
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

    const decisions = assessMigrationDecisions(historical.value, draft);
    if (!decisions.ok) return decisions;
    const unsupportedQuestion = decisions.value.find(question => question.kind === "unsupported");
    if (unsupportedQuestion !== undefined) return unsupported(historical.value.find(change => change.id === unsupportedQuestion.id)!);
    if (decisions.value.length > 0) return fail("migration.authoringPending", {
        changeIds: decisions.value.map(question => question.id).join(","), reason: "Migration has unresolved data decisions",
    });

    const manual = await validateManualSteps(
        historical.value,
        loadedDesired.value.expectedSchema,
        draft.manual,
        runtime,
    );
    if (!manual.ok) return manual;

    const inspected = await runtime.inspectDraft({...draft, manual: manual.value.steps});
    if (!inspected.ok) return inspected;

    const residual = inferStructureChanges(
        draft.base,
        inspected.value,
        loadedDesired.value.expectedSchema,
        residualRenames(inspected.value, loadedDesired.value.expectedSchema, draft.renames),
    );
    if (!residual.ok) return residual;

    const repeatedManualChange = residual.value.find(change => manual.value.claimedChangeIds.has(change.id));
    if (repeatedManualChange !== undefined) {
        return fail("migration.authoringInvalid", {
            changeId: repeatedManualChange.id,
            reason: "manual step claimed a change that remains after replay",
        });
    }

    const firstUnsupported = residual.value.find(change => change.impact === "unsupported");
    if (firstUnsupported !== undefined) return unsupported(firstUnsupported);

    const manualOperations: readonly CompiledAuthoringOperationInfo[] = manual.value.steps.map(step => ({
        id: "manual:" + step.id,
        stepIds: [step.id],
        changeIds: [...step.implementsChanges],
        dataMigrationIds: [],
    }));
    const operations = manualOperations;
    return compileGenerated(draft, runtime, inspected.value, loadedDesired.value.expectedSchema, residual.value, {
            formatVersion: 1,
            draftHash: draft.revisionHash,
            base: draft.base,
            migration: migrationForDraft(draft, manual.value),
            operations,
            decisions: draft.decisions,
            checkpoints: manual.value.checkpoints,
            queryResources: Object.freeze(Object.create(null) as Record<string, never>),
            validationArtifacts: [],
    });
}

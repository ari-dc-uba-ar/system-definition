import {
    problem,
    type MigrationInfo,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import type {
    AuthoringRuntime,
    CompiledAuthoringInfo,
    CompiledAuthoringOperationInfo,
    DestructiveDecisionInfo,
    FieldRefInfo,
    ManualStepInfo,
    MigrationDraftInfo,
    RenameInfo,
    StructureChangeInfo,
} from "./authoring-contract";
import {inferStructureChanges} from "./infer";
import type {DataMigrationInfo} from "./migration-authoring";
import type {PgObjectIdentity, PgObjectInfo, PgSchemaInfo} from "./pg-schema";
import {prepareManualSqlResource} from "./sql-resource";

export * from "./authoring-contract";

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

function pendingFor(change: StructureChangeInfo): ValidationResult<never> {
    return fail("migration.authoringPending", {
        changeId: change.id,
        impact: change.impact,
        action: change.action,
    });
}

function sameField(left: FieldRefInfo, right: FieldRefInfo): boolean {
    return left.side === right.side
        && left.entity === right.entity
        && left.field === right.field;
}

function decisionKey(changeId: string, source: FieldRefInfo | null): string {
    return source === null
        ? `${changeId}\0<object>`
        : `${changeId}\0${source.side}\0${source.entity}\0${source.field}`;
}

function sameIdentity(left: PgObjectIdentity, right: PgObjectIdentity): boolean {
    return left.schema === right.schema
        && left.kind === right.kind
        && left.name === right.name
        && left.parentName === right.parentName
        && left.signature.length === right.signature.length
        && left.signature.every((part, index) => part === right.signature[index]);
}

function hasIdentity(schema: PgSchemaInfo, identity: PgObjectIdentity): boolean {
    return schema.objects.some(object => sameIdentity(object.identity, identity));
}

type ValidatedManualInfo = {
    steps: readonly ManualStepInfo[];
    claimedChangeIds: ReadonlySet<string>;
};

function manualEffectCoversChange(step: ManualStepInfo, change: StructureChangeInfo): boolean {
    if (change.action === "add" && change.after !== null) {
        return step.writes.some(identity => sameIdentity(identity, change.after as PgObjectIdentity));
    }
    if (change.action === "remove" && change.before !== null) {
        return step.destroys.some(identity => sameIdentity(identity, change.before as PgObjectIdentity));
    }
    return true;
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

    const claimedChangeIds = new Set<string>();
    for (const step of manual) {
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
        if (step.before.length > 0 || step.after.length > 0 || step.rowChecks.length > 0 || step.dependsOn.length > 0) {
            return fail("migration.authoringPending", {
                stepId: step.id,
                reason: "manual checkpoints and dependency ordering require the remaining authoring integration slice",
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

    for (const step of manual) {
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

    return {ok: true, value: {steps: manual, claimedChangeIds}};
}

/**
 * T21 slice 2 keeps destructive coverage tied to the reconstructed historical
 * diff, while allowing an explicit field to be split by distinct check
 * resources.  A migrate decision is valid only when its named data migration
 * consumes that exact source field and writes every output the decision names.
 */
function partitionKey(decision: DestructiveDecisionInfo): string | null {
    const ref = decision.partitionCheck;
    return ref === null ? null : `${ref.kind}\0${ref.name}\0${ref.contentHash}`;
}

function migrationConsumesSource(migration: DataMigrationInfo, source: FieldRefInfo): boolean {
    return Object.values(migration.source.ports)
        .some(port => port.field !== null && sameField(port.field, source));
}

function migrationWritesOutput(migration: DataMigrationInfo, output: string): boolean {
    return migration.writes.some(write => write.values.some(binding => binding.output === output));
}

function validateMigrateDecision(
    decision: DestructiveDecisionInfo & {
        resolution: Extract<DestructiveDecisionInfo["resolution"], {kind: "migrate"}>;
    },
    data: readonly DataMigrationInfo[],
): ValidationResult<true> {
    const migration = data.find(candidate => candidate.id === decision.resolution.dataMigrationId);
    if (migration === undefined) {
        return fail("migration.invalidReference", {
            changeId: decision.changeId,
            dataMigrationId: decision.resolution.dataMigrationId,
            reason: "destructive migrate decision references an unknown data migration",
        });
    }
    if (decision.resolution.outputs.length === 0) {
        return fail("migration.authoringInvalid", {
            changeId: decision.changeId,
            reason: "destructive migrate decision requires at least one output",
        });
    }
    if (decision.source === null || !migrationConsumesSource(migration, decision.source)) {
        return fail("migration.invalidReference", {
            changeId: decision.changeId,
            dataMigrationId: migration.id,
            reason: "data migration does not consume the destructive source",
        });
    }

    const outputs = new Set<string>();
    for (const output of decision.resolution.outputs) {
        if (output.length === 0 || outputs.has(output)) {
            return fail("migration.authoringInvalid", {
                changeId: decision.changeId,
                reason: "destructive migrate outputs must be non-empty and unique",
            });
        }
        outputs.add(output);
        if (!migrationWritesOutput(migration, output)) {
            return fail("migration.invalidReference", {
                changeId: decision.changeId,
                dataMigrationId: migration.id,
                output,
                reason: "destructive migrate output is not written by the data migration",
            });
        }
    }
    return {ok: true, value: true};
}

function validateDestructiveDecisions(
    changes: readonly StructureChangeInfo[],
    decisions: readonly DestructiveDecisionInfo[],
    data: readonly DataMigrationInfo[],
): ValidationResult<readonly DestructiveDecisionInfo[]> {
    const destructive = changes.filter(change => change.impact === "destructive");
    const byId = new Map(destructive.map(change => [change.id, change] as const));
    const grouped = new Map<string, DestructiveDecisionInfo[]>();

    for (const decision of decisions) {
        const change = byId.get(decision.changeId);
        if (change === undefined) {
            return fail("migration.invalidReference", {
                changeId: decision.changeId,
                reason: "destructive decision does not belong to the reconstructed diff",
            });
        }

        if (decision.source === null) {
            if (change.affectedFields.length !== 0) {
                return fail("migration.invalidReference", {
                    changeId: decision.changeId,
                    reason: "object-level destructive decision cannot cover persisted fields",
                });
            }
        } else if (!change.affectedFields.some(field => sameField(field, decision.source as FieldRefInfo))) {
            return fail("migration.invalidReference", {
                changeId: decision.changeId,
                source: `${decision.source.side}:${decision.source.entity}.${decision.source.field}`,
                reason: "destructive decision source is not affected by the referenced change",
            });
        }

        if (decision.partitionCheck !== null && decision.partitionCheck.kind !== "check") {
            return fail("migration.authoringInvalid", {
                changeId: decision.changeId,
                reason: "destructive partition resource must be a check",
            });
        }

        if (decision.resolution.kind === "discard") {
            if (decision.resolution.reason.trim().length === 0) {
                return fail("migration.authoringInvalid", {
                    changeId: decision.changeId,
                    reason: "discard requires a non-empty reason",
                });
            }
        } else {
            const validated = validateMigrateDecision(
                decision as DestructiveDecisionInfo & {
                    resolution: Extract<DestructiveDecisionInfo["resolution"], {kind: "migrate"}>;
                },
                data,
            );
            if (!validated.ok) return validated;
        }

        const key = decisionKey(decision.changeId, decision.source);
        const matching = grouped.get(key) ?? [];
        matching.push(decision);
        grouped.set(key, matching);
    }

    for (const change of destructive) {
        const sources: readonly (FieldRefInfo | null)[] = change.affectedFields.length === 0
            ? [null]
            : change.affectedFields;
        for (const source of sources) {
            const matching = grouped.get(decisionKey(change.id, source)) ?? [];
            if (matching.length === 0) return pendingFor(change);

            const wholeField = matching.filter(decision => decision.partitionCheck === null);
            if (wholeField.length > 1 || (wholeField.length === 1 && matching.length > 1)) {
                return fail("migration.authoringInvalid", {
                    changeId: change.id,
                    reason: "whole-field and partition decisions cannot overlap",
                });
            }
            if (wholeField.length === 0) {
                const partitions = new Set<string>();
                for (const decision of matching) {
                    const key = partitionKey(decision);
                    if (key === null || partitions.has(key)) {
                        return fail("migration.authoringInvalid", {
                            changeId: change.id,
                            reason: "destructive partition decisions must use distinct checks",
                        });
                    }
                    partitions.add(key);
                }
            }
        }
    }

    return {ok: true, value: decisions};
}

function unsupported(change: StructureChangeInfo): ValidationResult<never> {
    return fail("migration.unsupportedSchemaFeature", {
        changeId: change.id,
        action: change.action,
        reason: "residual structure is outside T18 automatic generation coverage",
    });
}

function operationFor(change: StructureChangeInfo): CompiledAuthoringOperationInfo {
    return {
        id: "structure:" + change.id,
        stepIds: [],
        changeIds: [change.id],
        dataMigrationIds: [],
    };
}

function migrationForDraft(draft: MigrationDraftInfo): MigrationInfo {
    return {
        id: draft.id,
        from: draft.base.from,
        to: draft.base.to,
        description: "",
        before: [],
        steps: draft.manual.map(step => ({id: step.id, run: step.run})),
        after: [],
    };
}

/**
 * Compile the T18 structural portion of an authoring draft.
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
        return fail("migration.unsupportedFormat", {reason: "invalid T18 authoring draft"});
    }
    if (draft.pending.length > 0) {
        return fail("migration.authoringPending", {reason: "draft has unresolved authoring questions"});
    }
    const reconstructed = await runtime.reconstructHistory(draft.base.from);
    if (!reconstructed.ok) return reconstructed;

    const loadedDesired = await runtime.loadRelease(draft.base.to);
    if (!loadedDesired.ok) return loadedDesired;
    if (!sameRelease(loadedDesired.value.ref, draft.base.to)) {
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

    const destructiveDecisions = validateDestructiveDecisions(historical.value, draft.decisions, draft.data);
    if (!destructiveDecisions.ok) return destructiveDecisions;

    const manual = await validateManualSteps(
        historical.value,
        loadedDesired.value.expectedSchema,
        draft.manual,
        runtime,
    );
    if (!manual.ok) return manual;

    const referencedDataIds = new Set(
        draft.decisions
            .filter((decision): decision is DestructiveDecisionInfo & {
                resolution: Extract<DestructiveDecisionInfo["resolution"], {kind: "migrate"}>;
            } => decision.resolution.kind === "migrate")
            .map(decision => decision.resolution.dataMigrationId),
    );
    if (draft.data.some(migration => !referencedDataIds.has(migration.id))) {
        return fail("migration.authoringPending", {
            reason: "unreferenced data migrations require a later authoring slice",
        });
    }

    const inspected = await runtime.inspectDraft(draft);
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

    const firstPending = residual.value.find(change => change.impact === "requiresDataCheck"
        || change.impact === "destructive");
    if (firstPending !== undefined) return pendingFor(firstPending);

    const manualOperations: readonly CompiledAuthoringOperationInfo[] = manual.value.steps.map(step => ({
        id: "manual:" + step.id,
        stepIds: [step.id],
        changeIds: [...step.implementsChanges],
        dataMigrationIds: [],
    }));
    const dataOperations: readonly CompiledAuthoringOperationInfo[] = draft.data.map(migration => ({
        id: "data:" + migration.id,
        stepIds: [],
        changeIds: [],
        dataMigrationIds: [migration.id],
    }));
    const migrateChangeIds = new Set(
        draft.decisions
            .filter(decision => decision.resolution.kind === "migrate")
            .map(decision => decision.changeId),
    );
    const destructiveOperations = historical.value
        .filter(change => change.impact === "destructive"
            && migrateChangeIds.has(change.id)
            && !manual.value.claimedChangeIds.has(change.id))
        .map(operationFor);
    const operations = [
        ...manualOperations,
        ...dataOperations,
        ...destructiveOperations,
        ...residual.value.map(operationFor),
    ];
    return {
        ok: true,
        value: {
            formatVersion: 1,
            draftHash: draft.revisionHash,
            base: draft.base,
            migration: migrationForDraft(draft),
            operations,
            decisions: destructiveDecisions.value,
            checkpoints: [],
            queryResources: Object.freeze(Object.create(null) as Record<string, never>),
            validationArtifacts: [],
        },
    };
}

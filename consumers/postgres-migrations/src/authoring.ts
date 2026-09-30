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
    FieldRefInfo,
    MigrationDraftInfo,
    RenameInfo,
    StructureChangeInfo,
} from "./authoring-contract";
import {inferStructureChanges} from "./infer";
import type {PgObjectInfo, PgSchemaInfo} from "./pg-schema";

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

function emptyMigration(draft: MigrationDraftInfo): MigrationInfo {
    return {
        id: draft.id,
        from: draft.base.from,
        to: draft.base.to,
        description: "",
        before: [],
        steps: [],
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
    if (draft.data.length > 0 || draft.decisions.length > 0 || draft.manual.length > 0) {
        return fail("migration.authoringPending", {
            reason: "data, destructive decisions and manual SQL require T19-T21 compilation",
        });
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

    const inspected = await runtime.inspectDraft(draft);
    if (!inspected.ok) return inspected;

    const residual = inferStructureChanges(
        draft.base,
        inspected.value,
        loadedDesired.value.expectedSchema,
        residualRenames(inspected.value, loadedDesired.value.expectedSchema, draft.renames),
    );
    if (!residual.ok) return residual;

    const firstUnsupported = residual.value.find(change => change.impact === "unsupported");
    if (firstUnsupported !== undefined) return unsupported(firstUnsupported);

    const firstPending = residual.value.find(change => change.impact === "requiresDataCheck"
        || change.impact === "destructive");
    if (firstPending !== undefined) return pendingFor(firstPending);

    const operations = residual.value.map(operationFor);
    return {
        ok: true,
        value: {
            formatVersion: 1,
            draftHash: draft.revisionHash,
            base: draft.base,
            migration: emptyMigration(draft),
            operations,
            decisions: [],
            checkpoints: [],
            queryResources: Object.freeze(Object.create(null) as Record<string, never>),
            validationArtifacts: [],
        },
    };
}

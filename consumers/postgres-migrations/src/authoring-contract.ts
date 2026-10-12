import {
    childPath,
    decodeResourceRefInfo,
    exactKeys,
    isNonEmptyString,
    isPlainObject,
    type FileResourceInfo,
    type FileInfo,
    type PersistenceInfo,
    type JsonValue,
    type MigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type StructuralFailure,
    type ValidationResult,
} from "system-definition";
import type {PgObjectIdentity, PgSchemaInfo} from "./pg-schema";
import type {SchemaDifferenceInfo} from "./compare-schema";
import type {DataMigrationInfo, FieldRefInfo, QueryRefInfo} from "./migration-authoring";
import type {AuthoringContext} from "./migration-authoring";
import type {StorageContext} from "./pg-schema";
import type {ValidationArtifactInfo} from "./validation-artifact";
import type {AuthoredResource} from "./authoring-files";

export type {FieldRefInfo, QueryRefInfo, SnapshotSide} from "./migration-authoring";

export type QueryResourceInfo = FileResourceInfo<"query">;

export type AuthoringBaseInfo = {
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    fromSnapshotHash: string;
    toSnapshotHash: string;
    fromPersistenceHash: string;
    toPersistenceHash: string;
};

export type ChangeImpact = "preserving" | "requiresDataCheck" | "destructive" | "unsupported";

export type StructureDifferenceInfo = Pick<SchemaDifferenceInfo, "path" | "before" | "after">;

export type StructureChangeInfo = {
    id: string;
    action: "add" | "remove" | "alter" | "rename";
    origin: "inferred" | "authored";
    impact: ChangeImpact;
    before: PgObjectIdentity | null;
    after: PgObjectIdentity | null;
    differences: readonly StructureDifferenceInfo[];
    affectedFields: readonly FieldRefInfo[];
    dependsOn: readonly string[];
};

export type EntityRefInfo = {
    entity: string;
};

export type RenameInfo = {
    before: FieldRefInfo | EntityRefInfo;
    after: FieldRefInfo | EntityRefInfo;
};

export type DataDecisionInfo = {
    changeId: string;
    source: FieldRefInfo | null;
    partitionCheck: ResourceRefInfo | null;
    resolution:
        | {kind: "discard"; reason: string}
        | {kind: "migrate"; dataMigrationId: string; outputs: readonly string[]}
        | {kind: "check"; run: ResourceRefInfo};
};

export type DestructiveDecisionInfo = Omit<DataDecisionInfo, "resolution"> & {
    resolution: Exclude<DataDecisionInfo["resolution"], {kind: "check"}>;
};

export function decodeFieldRefInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<FieldRefInfo> {
    if (!isPlainObject(value)) return invalid(path, "expected a field reference");
    const shape = exactKeys(value, ["side", "entity", "field"], path, invalid);
    if (!shape.ok) return shape;
    if (value.side !== "from" && value.side !== "to") {
        return invalid(childPath(path, "side"), "field side must be from or to");
    }
    if (!isNonEmptyString(value.entity)) {
        return invalid(childPath(path, "entity"), "field entity must not be empty");
    }
    if (!isNonEmptyString(value.field)) {
        return invalid(childPath(path, "field"), "field name must not be empty");
    }
    return {ok: true, value: {side: value.side, entity: value.entity, field: value.field}};
}

export function decodeDataDecisionInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<DataDecisionInfo> {
    if (!isPlainObject(value)) return invalid(path, "expected a data decision");
    const shape = exactKeys(value, ["changeId", "source", "partitionCheck", "resolution"], path, invalid);
    if (!shape.ok) return shape;
    if (!isNonEmptyString(value.changeId)) {
        return invalid(childPath(path, "changeId"), "changeId must not be empty");
    }

    let source: FieldRefInfo | null = null;
    if (value.source !== null) {
        const decoded = decodeFieldRefInfo(value.source, childPath(path, "source"), invalid);
        if (!decoded.ok) return decoded;
        source = decoded.value;
    }

    let partitionCheck: ResourceRefInfo | null = null;
    if (value.partitionCheck !== null) {
        const checkPath = childPath(path, "partitionCheck");
        const decoded = decodeResourceRefInfo(value.partitionCheck, checkPath, invalid);
        if (!decoded.ok) return decoded;
        if (decoded.value.kind !== "check") {
            return invalid(childPath(checkPath, "kind"), "partitionCheck must reference a check resource");
        }
        partitionCheck = decoded.value;
    }

    const resolutionPath = childPath(path, "resolution");
    if (!isPlainObject(value.resolution)) {
        return invalid(resolutionPath, "expected a data resolution");
    }

    if (value.resolution.kind === "check") {
        const checked = exactKeys(value.resolution, ["kind", "run"], resolutionPath, invalid);
        if (!checked.ok) return checked;
        const run = decodeResourceRefInfo(value.resolution.run, childPath(resolutionPath, "run"), invalid);
        if (!run.ok) return run;
        if (run.value.kind !== "check") return invalid(childPath(resolutionPath, "run"), "expected a check resource");
        return {ok: true, value: {changeId: value.changeId, source, partitionCheck, resolution: {kind: "check", run: run.value}}};
    }

    if (value.resolution.kind === "discard") {
        const discardShape = exactKeys(value.resolution, ["kind", "reason"], resolutionPath, invalid);
        if (!discardShape.ok) return discardShape;
        if (!isNonEmptyString(value.resolution.reason)) {
            return invalid(childPath(resolutionPath, "reason"), "discard reason must not be empty");
        }
        return {
            ok: true,
            value: {
                changeId: value.changeId,
                source,
                partitionCheck,
                resolution: {kind: "discard", reason: value.resolution.reason},
            },
        };
    }

    if (value.resolution.kind === "migrate") {
        const migrateShape = exactKeys(
            value.resolution,
            ["kind", "dataMigrationId", "outputs"],
            resolutionPath,
            invalid,
        );
        if (!migrateShape.ok) return migrateShape;
        if (!isNonEmptyString(value.resolution.dataMigrationId)) {
            return invalid(childPath(resolutionPath, "dataMigrationId"), "dataMigrationId must not be empty");
        }
        const outputsPath = childPath(resolutionPath, "outputs");
        if (!Array.isArray(value.resolution.outputs) || value.resolution.outputs.length === 0) {
            return invalid(outputsPath, "migrate outputs must contain at least one output");
        }
        const outputs: string[] = [];
        const seen = new Set<string>();
        for (let index = 0; index < value.resolution.outputs.length; index++) {
            const output = value.resolution.outputs[index];
            const outputPath = `${outputsPath}[${index}]`;
            if (!isNonEmptyString(output)) return invalid(outputPath, "migrate output must not be empty");
            if (seen.has(output)) return invalid(outputPath, "migrate outputs must be unique");
            seen.add(output);
            outputs.push(output);
        }
        return {
            ok: true,
            value: {
                changeId: value.changeId,
                source,
                partitionCheck,
                resolution: {kind: "migrate", dataMigrationId: value.resolution.dataMigrationId, outputs},
            },
        };
    }

    return invalid(childPath(resolutionPath, "kind"), "unknown data resolution kind");
}

export function decodeDestructiveDecisionInfo(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<DestructiveDecisionInfo> {
    const decoded = decodeDataDecisionInfo(value, path, invalid);
    if (!decoded.ok) return decoded;
    if (decoded.value.resolution.kind === "check") return invalid(path, "a check cannot authorize destructive data loss");
    return {ok: true, value: {...decoded.value, resolution: decoded.value.resolution}};
}


export type PendingQuestionInfo = {
    id: string;
    kind: "rename" | "dataRequired" | "destructive" | "rowMapping" | "unsupported";
    subjects: readonly string[];
    messageKey: string;
};

export type ManualStepInfo = {
    id: string;
    run: ResourceRefInfo;
    dependsOn: readonly string[];
    implementsChanges: readonly string[];
    reads: readonly PgObjectIdentity[];
    writes: readonly PgObjectIdentity[];
    destroys: readonly PgObjectIdentity[];
    before: readonly ResourceRefInfo[];
    after: readonly ResourceRefInfo[];
    rowChecks: readonly unknown[];
};

/** Authored choices belong to the migration; changes and pending are derived. */
export type MigrationDraftInfo = {
    formatVersion: 1;
    id: string;
    base: AuthoringBaseInfo;
    revisionHash: string;
    renames: readonly RenameInfo[];
    changes: readonly StructureChangeInfo[];
    data: readonly DataMigrationInfo[];
    decisions: readonly DataDecisionInfo[];
    manual: readonly ManualStepInfo[];
    pending: readonly PendingQuestionInfo[];
};

export type AuthoringReleaseBundle = {
    ref: ReleaseRefInfo;
    expectedSchema: PgSchemaInfo;
};

export interface AuthoringRuntime {
    /** Consumer policy applied after all generated DDL/data, before target invariants. */
    finalSteps?: MigrationInfo["steps"];
    loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<AuthoringReleaseBundle>>;
    reconstructHistory(head: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>>;
    readQuery?(ref: QueryRefInfo): Promise<ValidationResult<string>>;
    readSql?(ref: ResourceRefInfo): Promise<ValidationResult<string>>;
    inspectDraft(draft: MigrationDraftInfo): Promise<ValidationResult<PgSchemaInfo>>;
    emitResource?(resource: AuthoredResource): Promise<ValidationResult<FileInfo>>;
    inspectCompiled?(compiled: CompiledAuthoringInfo): Promise<ValidationResult<PgSchemaInfo>>;
    loadDataContext?(): Promise<ValidationResult<{
        context: AuthoringContext;
        persistence: PersistenceInfo;
        storage: StorageContext;
        validationArtifacts: readonly ValidationArtifactInfo[];
    }>>;
}

export type CompiledAuthoringOperationInfo = {
    id: string;
    stepIds: readonly string[];
    changeIds: readonly string[];
    dataMigrationIds: readonly string[];
};

export type CompiledAuthoringInfo = {
    formatVersion: 1;
    draftHash: string;
    base: AuthoringBaseInfo;
    migration: MigrationInfo;
    operations: readonly CompiledAuthoringOperationInfo[];
    decisions: readonly DataDecisionInfo[];
    checkpoints: readonly {afterStep: string; checks: readonly ResourceRefInfo[]; rows: readonly unknown[]}[];
    queryResources: Readonly<Record<string, QueryResourceInfo>>;
    validationArtifacts: readonly unknown[];
};

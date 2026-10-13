import {
    childPath,
    decodeReleaseRefInfo,
    isSha256,
    decodeArray,
    hasExactKeys,
    decodeResourceRefInfo,
    exactKeys,
    isNonEmptyString,
    isPlainObject,
    type FileResourceInfo,
    type ContentRefInfo,
    type FileInfo,
    type PersistenceInfo,
    type MigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type StructuralFailure,
    type ValidationResult,
} from "system-definition";
import {decodeFieldRefInfo} from "./data-authoring-codec";
export {decodeFieldRefInfo} from "./data-authoring-codec";
import type {PgObjectIdentity, PgSchemaInfo} from "./pg-schema";
import {decodePgObjectIdentity} from "./pg-identity";
import type {SchemaDifferenceInfo} from "./compare-schema";
import type {DataMigrationInfo, FieldRefInfo, PortInfo, QueryRefInfo, SnapshotSide} from "./migration-authoring";
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


export function decodeAuthoringBase(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<AuthoringBaseInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["from", "to", "fromSnapshotHash", "toSnapshotHash", "fromPersistenceHash", "toPersistenceHash"])
        || !isSha256(value.fromSnapshotHash) || !isSha256(value.toSnapshotHash)
        || !isSha256(value.fromPersistenceHash) || !isSha256(value.toPersistenceHash)) return invalid(path, "invalid authoring base");
    const from = decodeReleaseRefInfo(value.from, path + ".from", invalid); if (!from.ok) return from;
    const to = decodeReleaseRefInfo(value.to, path + ".to", invalid); if (!to.ok) return to;
    return {ok: true, value: {from: from.value, to: to.value, fromSnapshotHash: value.fromSnapshotHash, toSnapshotHash: value.toSnapshotHash,
        fromPersistenceHash: value.fromPersistenceHash, toPersistenceHash: value.toPersistenceHash}};
}

export type ChangeImpact = "preserving" | "requiresDataCheck" | "destructive" | "unsupported";

export type StructureDifferenceInfo = Pick<SchemaDifferenceInfo, "path" | "before" | "after">;

export type StructureChangeInfo = {
    id: string;
    origin: "inferred" | "authored";
    impact: ChangeImpact;
    differences: readonly StructureDifferenceInfo[];
    affectedFields: readonly FieldRefInfo[];
    dependsOn: readonly string[];
} & (
    | {action: "add"; before: null; after: PgObjectIdentity}
    | {action: "remove"; before: PgObjectIdentity; after: null}
    | {action: "alter"; before: PgObjectIdentity; after: PgObjectIdentity}
    | {action: "rename"; before: PgObjectIdentity; after: PgObjectIdentity}
);

export type EntityRefInfo = {
    entity: string;
    field?: never;
};

export type RenameInfo =
    | {before: FieldRefInfo & {side: "from"}; after: FieldRefInfo & {side: "to"}}
    | {before: EntityRefInfo; after: EntityRefInfo};

export function isFieldRename(rename: RenameInfo): rename is Extract<RenameInfo, {before: FieldRefInfo}> {
    return Object.hasOwn(rename.before, "field");
}

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


/** Decode manual effects once; assembly owns reference/effect semantics. */
export function decodeManualStepInfo(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<ManualStepInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["id", "run", "dependsOn", "implementsChanges", "reads", "writes", "destroys", "before", "after", "rowChecks"])
        || !isNonEmptyString(value.id) || !Array.isArray(value.rowChecks)) return invalid(path, "invalid manual step");
    const strings = (raw: unknown, at: string) => isNonEmptyString(raw) ? {ok: true as const, value: raw} : invalid(at, "expected a name");
    const run = decodeResourceRefInfo(value.run, path + ".run", invalid); if (!run.ok) return run;
    const dependsOn = decodeArray(value.dependsOn, path + ".dependsOn", invalid, strings); if (!dependsOn.ok) return dependsOn;
    const implementsChanges = decodeArray(value.implementsChanges, path + ".implementsChanges", invalid, strings); if (!implementsChanges.ok) return implementsChanges;
    const reads = decodeArray(value.reads, path + ".reads", invalid, (raw, at) => decodePgObjectIdentity(raw, at, invalid)); if (!reads.ok) return reads;
    const writes = decodeArray(value.writes, path + ".writes", invalid, (raw, at) => decodePgObjectIdentity(raw, at, invalid)); if (!writes.ok) return writes;
    const destroys = decodeArray(value.destroys, path + ".destroys", invalid, (raw, at) => decodePgObjectIdentity(raw, at, invalid)); if (!destroys.ok) return destroys;
    const before = decodeArray(value.before, path + ".before", invalid, (raw, at) => decodeResourceRefInfo(raw, at, invalid)); if (!before.ok) return before;
    const after = decodeArray(value.after, path + ".after", invalid, (raw, at) => decodeResourceRefInfo(raw, at, invalid)); if (!after.ok) return after;
    return {ok: true, value: {id: value.id, run: run.value, dependsOn: dependsOn.value, implementsChanges: implementsChanges.value,
        reads: reads.value, writes: writes.value, destroys: destroys.value, before: before.value, after: after.value, rowChecks: value.rowChecks}};
}

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

export type AuthoringCheckpointRowInfo = {
    id: string;
    afterStep: string;
    side: SnapshotSide;
    select: QueryRefInfo;
    validatorArtifactHash: string;
} & ({entity: string; ports?: never} | {ports: Readonly<Record<string, PortInfo>>; entity?: never});

export type CompiledAuthoringInfo = {
    formatVersion: 1;
    draftHash: string;
    base: AuthoringBaseInfo;
    migration: MigrationInfo;
    operations: readonly CompiledAuthoringOperationInfo[];
    decisions: readonly DataDecisionInfo[];
    checkpoints: readonly {afterStep: string; checks: readonly ResourceRefInfo[]; rows: readonly AuthoringCheckpointRowInfo[]}[];
    queryResources: Readonly<Record<string, QueryResourceInfo>>;
    validationArtifacts: readonly ValidationArtifactInfo[];
    states?: {from: FileInfo; to: FileInfo};
    initial?: ContentRefInfo<"sql">;
};

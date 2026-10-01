import type {
    FileInfo,
    JsonValue,
    MigrationInfo,
    ReleaseRefInfo,
    ResourceRefInfo,
    ValidationResult,
} from "system-definition";
import type {PgObjectIdentity, PgSchemaInfo} from "./pg-schema";
import type {DataMigrationInfo, FieldRefInfo, QueryRefInfo} from "./migration-authoring";

export type {FieldRefInfo, QueryRefInfo, SnapshotSide} from "./migration-authoring";

export type QueryResourceInfo = {
    kind: "query";
    file: FileInfo;
};

export type AuthoringBaseInfo = {
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    fromSnapshotHash: string;
    toSnapshotHash: string;
    fromPersistenceHash: string;
    toPersistenceHash: string;
};

export type ChangeImpact = "preserving" | "requiresDataCheck" | "destructive" | "unsupported";

export type StructureDifferenceInfo = {
    path: readonly string[];
    before: JsonValue;
    after: JsonValue;
};

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

export type DestructiveDecisionInfo = {
    changeId: string;
    source: FieldRefInfo | null;
    partitionCheck: ResourceRefInfo | null;
    resolution:
        | {kind: "discard"; reason: string}
        | {kind: "migrate"; dataMigrationId: string; outputs: readonly string[]};
};


export type PendingQuestionInfo = {
    id: string;
    kind: "rename" | "dataRequired" | "destructive" | "rowMapping" | "unsupported";
    subjects: readonly string[];
    messageKey: string;
};

/**
 * T18 owns the structural authoring base. Data migrations and manual SQL are
 * refined by later tasks; T21 makes destructive decisions explicit here while
 * keeping the not-yet-compiled authoring slots representable.
 */
export type MigrationDraftInfo = {
    formatVersion: 1;
    id: string;
    base: AuthoringBaseInfo;
    revisionHash: string;
    renames: readonly RenameInfo[];
    changes: readonly StructureChangeInfo[];
    data: readonly DataMigrationInfo[];
    decisions: readonly DestructiveDecisionInfo[];
    manual: readonly unknown[];
    pending: readonly PendingQuestionInfo[];
};

export type AuthoringReleaseBundle = {
    ref: ReleaseRefInfo;
    expectedSchema: PgSchemaInfo;
};

export interface AuthoringRuntime {
    loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<AuthoringReleaseBundle>>;
    reconstructHistory(head: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>>;
    readQuery(ref: QueryRefInfo): Promise<ValidationResult<string>>;
    inspectDraft(draft: MigrationDraftInfo): Promise<ValidationResult<PgSchemaInfo>>;
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
    decisions: readonly DestructiveDecisionInfo[];
    checkpoints: readonly unknown[];
    queryResources: Readonly<Record<string, QueryResourceInfo>>;
    validationArtifacts: readonly unknown[];
};

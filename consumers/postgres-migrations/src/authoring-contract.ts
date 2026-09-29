import type {
    JsonValue,
    ReleaseRefInfo,
} from "system-definition";
import type {PgObjectIdentity} from "./pg-schema";

export type SnapshotSide = "from" | "to";

export type FieldRefInfo = {
    side: SnapshotSide;
    entity: string;
    field: string;
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

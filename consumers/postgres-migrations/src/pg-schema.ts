import {
    problem,
    type PersistenceInfo,
    type Problem,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import type {EnvironmentInfo, ManagedDataInfo} from "./artifact";
import {quotePgIdentifier, quotePgQualified} from "./pg-sql";
export {quotePgIdentifier, quotePgQualified} from "./pg-sql";

export type PgTypeRepresentation = {
    schema: string;
    name: string;
    modifiers: readonly string[];
};

export type MachineCodecInfo = {
    readExpression: string;
    transportType: string;
};

export type PgObjectIdentity = {
    schema: string;
    kind: string;
    name: string;
    parentName: string | null;
    signature: readonly string[];
};

export type PgTypeInfo = {
    schema: string;
    name: string;
    modifiers: readonly string[];
    arrayDimensions: number;
    collation: string | null;
};

export type PgObjectInfo =
    | {
        kind: "table";
        identity: PgObjectIdentity;
        persistence: string;
        relationKind: string;
    }
    | {
        kind: "column";
        identity: PgObjectIdentity;
        type: PgTypeInfo;
        nullable: boolean;
        defaultExpression: string | null;
        identityDefinition: string | null;
        generatedDefinition: string | null;
    }
    | {
        kind: "constraint";
        identity: PgObjectIdentity;
        constraintKind: "primaryKey" | "unique" | "foreignKey" | "check";
        definition: string;
        columns: readonly string[];
        target: PgObjectIdentity | null;
        pairs: readonly {source: string; target: string}[];
        deferrable: boolean;
        initiallyDeferred: boolean;
        validated: boolean;
        enforced: boolean;
    }
    | {
        kind: "index";
        identity: PgObjectIdentity;
        definition: string;
        valid: boolean;
        ready: boolean;
        ownerConstraint: PgObjectIdentity | null;
    }
    | {
        kind: "view";
        identity: PgObjectIdentity;
        definition: string;
        columns: readonly string[];
        options: Readonly<Record<string, string>>;
    }
    | {
        kind: "routine";
        identity: PgObjectIdentity;
        routineKind: "function" | "procedure";
        definition: string;
    };

export type PgSchemaInfo = {
    formatVersion: 1;
    engineVersion: "18.6";
    schemas: readonly string[];
    objects: readonly PgObjectInfo[];
};

export type PgColumnProjection = {
    name: string;
    type: PgTypeInfo;
    nullable: boolean;
};

export type PgKeyProjection = {
    name: string;
    columns: readonly string[];
};

export type PgForeignKeyProjection = {
    name: string;
    columns: readonly {source: string; target: string}[];
    target: {schema: string; name: string};
};

export type PgTableProjection = {
    schema: string;
    name: string;
    columns: readonly PgColumnProjection[];
    primaryKey: PgKeyProjection;
    uniqueKeys: readonly PgKeyProjection[];
    foreignKeys: readonly PgForeignKeyProjection[];
};

export type ProjectedPgSchemaInfo = PgSchemaInfo & {
    tables: readonly PgTableProjection[];
};

export type CreateResourceInfo = {
    id: string;
    run: ResourceRefInfo;
    dependsOn: readonly string[];
    expectedObjects: readonly PgObjectIdentity[];
};

export type ResolvedSqlResource = {
    ref: ResourceRefInfo;
    text: string;
};

export type StorageContext = {
    representation: string;
    physicalTypes: Readonly<Record<string, PgTypeRepresentation>>;
    machineCodecs?: Readonly<Record<string, MachineCodecInfo>>;
    schema: string;
    environment: EnvironmentInfo;
    resources: Readonly<Record<string, ResolvedSqlResource>>;
    createResources: readonly CreateResourceInfo[];
    managedData: readonly ManagedDataInfo[];
    invariantChecks: readonly ResourceRefInfo[];
};

export type SqlParameter = null | boolean | number | string | Uint8Array;

export interface PgSession {
    query(text: string, values: readonly SqlParameter[]): Promise<{
        rows: readonly Readonly<Record<string, unknown>>[];
        rowCount: number | null;
    }>;
    close(): Promise<void>;
}

const encoder = new TextEncoder();
const PG_IDENTIFIER_LIMIT = 63;

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function utf16Compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function validName(value: string): boolean {
    return value.length > 0 && !value.includes("\0");
}

function identifierBytes(value: string): number {
    return encoder.encode(value).byteLength;
}

function constraintName(table: string, suffix: string): ValidationResult<string> {
    const value = table + "_" + suffix;
    if (identifierBytes(value) > PG_IDENTIFIER_LIMIT) {
        return fail("migration.unsupportedSchemaFeature", {
            object: value,
            reason: "PostgreSQL identifier exceeds 63 bytes",
        });
    }
    return {ok: true, value};
}

function tableIdentity(schema: string, name: string): PgObjectIdentity {
    return {schema, kind: "table", name, parentName: null, signature: []};
}

function columnIdentity(schema: string, table: string, name: string): PgObjectIdentity {
    return {schema, kind: "column", name, parentName: table, signature: []};
}

function constraintIdentity(schema: string, table: string, name: string): PgObjectIdentity {
    return {schema, kind: "constraint", name, parentName: table, signature: []};
}


function keyDefinition(kind: "PRIMARY KEY" | "UNIQUE", columns: readonly string[]): string {
    return kind + " (" + columns.map(quotePgIdentifier).join(", ") + ")";
}

function fkDefinition(
    schema: string,
    targetTable: string,
    pairs: readonly {source: string; target: string}[],
): string {
    return "FOREIGN KEY (" + pairs.map(one => quotePgIdentifier(one.source)).join(", ") + ") REFERENCES "
        + quotePgQualified(schema, targetTable) + " (" + pairs.map(one => quotePgIdentifier(one.target)).join(", ") + ")";
}

function environmentProblem(storage: StorageContext): Problem | null {
    const environment = storage.environment;
    if (environment.engine !== "postgresql"
        || environment.version !== "18.6"
        || environment.serverVersionNum !== 180006) {
        return problem(null, "migration.environmentMismatch", "blocking", {
            expected: "postgresql 18.6 / 180006",
            actual: environment.engine + " " + environment.version + " / " + String(environment.serverVersionNum),
        });
    }
    return null;
}

function resolvePhysicalTypes(
    snapshot: SystemSnapshotInfo,
    persistence: PersistenceInfo,
    storage: StorageContext,
): ValidationResult<Readonly<Record<string, PgTypeInfo>>> {
    const representation = persistence.representations[storage.representation];
    if (representation === undefined) {
        return fail("migration.invalidReference", {
            representation: storage.representation,
            reason: "unknown persistence representation",
        });
    }

    const logicalNames = [...snapshot.typeNames];
    const logicalSet = new Set(logicalNames);
    const extra = Object.keys(representation).find(name => !logicalSet.has(name));
    if (extra !== undefined) {
        return fail("migration.invalidReference", {type: extra, reason: "unknown logical type mapping"});
    }

    const result: Record<string, PgTypeInfo> = Object.create(null) as Record<string, PgTypeInfo>;
    for (const logicalName of logicalNames) {
        const physicalName = representation[logicalName];
        if (typeof physicalName !== "string" || physicalName.length === 0) {
            return fail("migration.invalidReference", {type: logicalName, reason: "missing physical type mapping"});
        }
        const physical = storage.physicalTypes[physicalName];
        if (physical === undefined) {
            return fail("migration.invalidReference", {
                type: logicalName,
                physicalType: physicalName,
                reason: "unknown PostgreSQL physical type",
            });
        }
        if (!validName(physical.schema) || !validName(physical.name)
            || physical.modifiers.some(modifier => modifier.includes("\0"))) {
            return fail("migration.unsupportedFormat", {
                physicalType: physicalName,
                reason: "invalid PostgreSQL type representation",
            });
        }
        result[logicalName] = {
            schema: physical.schema,
            name: physical.name,
            modifiers: [...physical.modifiers],
            arrayDimensions: 0,
            collation: null,
        };
    }
    return {ok: true, value: result};
}

export function projectSchema(
    snapshot: SystemSnapshotInfo,
    persistence: PersistenceInfo,
    storage: StorageContext,
): ValidationResult<ProjectedPgSchemaInfo> {
    const mismatch = environmentProblem(storage);
    if (mismatch !== null) return {ok: false, problems: [mismatch]};
    if (!validName(storage.schema)) {
        return fail("migration.unsupportedFormat", {schema: storage.schema, reason: "invalid PostgreSQL schema name"});
    }

    const physicalTypes = resolvePhysicalTypes(snapshot, persistence, storage);
    if (!physicalTypes.ok) return physicalTypes;

    const selected = [...persistence.entities];
    if (new Set(selected).size !== selected.length) {
        return fail("migration.unsupportedFormat", {reason: "persistence entities must not repeat"});
    }
    selected.sort(utf16Compare);

    const objects: PgObjectInfo[] = [];
    const tables: PgTableProjection[] = [];
    const constraintNames = new Set<string>();

    for (const entityName of selected) {
        const entity = snapshot.entities[entityName];
        if (entity === undefined) {
            return fail("migration.invalidReference", {entity: entityName, reason: "selected entity does not exist in snapshot"});
        }
        if (!validName(entityName)) {
            return fail("migration.unsupportedFormat", {entity: entityName, reason: "invalid PostgreSQL table name"});
        }

        objects.push({
            kind: "table",
            identity: tableIdentity(storage.schema, entityName),
            persistence: "permanent",
            relationKind: "r",
        });

        const columns: PgColumnProjection[] = [];
        const fieldNames = Object.keys(entity.fields).sort(utf16Compare);
        for (const fieldName of fieldNames) {
            const field = entity.fields[fieldName];
            const pgType = physicalTypes.value[field.type];
            if (pgType === undefined) {
                return fail("migration.invalidReference", {
                    entity: entityName,
                    field: fieldName,
                    type: field.type,
                    reason: "field type is not mapped",
                });
            }
            if (!validName(fieldName)) {
                return fail("migration.unsupportedFormat", {entity: entityName, field: fieldName, reason: "invalid PostgreSQL column name"});
            }
            const typeCopy: PgTypeInfo = {...pgType, modifiers: [...pgType.modifiers]};
            columns.push({name: fieldName, type: typeCopy, nullable: field.nullable});
            objects.push({
                kind: "column",
                identity: columnIdentity(storage.schema, entityName, fieldName),
                type: typeCopy,
                nullable: field.nullable,
                defaultExpression: null,
                identityDefinition: null,
                generatedDefinition: null,
            });
        }

        if (entity.pk.length === 0) {
            return fail("migration.unsupportedSchemaFeature", {entity: entityName, reason: "persistent entity requires a primary key"});
        }
        const pkName = constraintName(entityName, "pkey");
        if (!pkName.ok) return pkName;
        if (constraintNames.has(pkName.value)) {
            return fail("migration.unsupportedSchemaFeature", {constraint: pkName.value, reason: "constraint name collision"});
        }
        constraintNames.add(pkName.value);
        const primaryKey: PgKeyProjection = {name: pkName.value, columns: [...entity.pk]};
        objects.push({
            kind: "constraint",
            identity: constraintIdentity(storage.schema, entityName, pkName.value),
            constraintKind: "primaryKey",
            definition: keyDefinition("PRIMARY KEY", entity.pk),
            columns: [...entity.pk],
            target: null,
            pairs: [],
            deferrable: false,
            initiallyDeferred: false,
            validated: true,
            enforced: true,
        });

        const uniqueKeys: PgKeyProjection[] = [];
        for (const ukName of Object.keys(entity.uks).sort(utf16Compare)) {
            const columns = entity.uks[ukName];
            const name = constraintName(entityName, ukName + "_key");
            if (!name.ok) return name;
            if (constraintNames.has(name.value)) {
                return fail("migration.unsupportedSchemaFeature", {constraint: name.value, reason: "constraint name collision"});
            }
            constraintNames.add(name.value);
            uniqueKeys.push({name: name.value, columns: [...columns]});
            objects.push({
                kind: "constraint",
                identity: constraintIdentity(storage.schema, entityName, name.value),
                constraintKind: "unique",
                definition: keyDefinition("UNIQUE", columns),
                columns: [...columns],
                target: null,
                pairs: [],
                deferrable: false,
                initiallyDeferred: false,
                validated: true,
                enforced: true,
            });
        }

        const foreignKeys: PgForeignKeyProjection[] = [];
        for (const fkName of Object.keys(entity.fks).sort(utf16Compare)) {
            const fk = entity.fks[fkName];
            if (snapshot.entities[fk.entity] === undefined) {
                return fail("migration.invalidReference", {entity: entityName, fk: fkName, target: fk.entity, reason: "unknown FK target"});
            }
            if (!selected.includes(fk.entity)) {
                return fail("migration.invalidReference", {entity: entityName, fk: fkName, target: fk.entity, reason: "FK target is not selected for persistence"});
            }
            const name = constraintName(entityName, fkName + "_fkey");
            if (!name.ok) return name;
            if (constraintNames.has(name.value)) {
                return fail("migration.unsupportedSchemaFeature", {constraint: name.value, reason: "constraint name collision"});
            }
            constraintNames.add(name.value);
            const pairs = Object.entries(fk.fields).map(([source, target]) => ({source, target}));
            foreignKeys.push({
                name: name.value,
                columns: pairs.map(one => ({...one})),
                target: {schema: storage.schema, name: fk.entity},
            });
            objects.push({
                kind: "constraint",
                identity: constraintIdentity(storage.schema, entityName, name.value),
                constraintKind: "foreignKey",
                definition: fkDefinition(storage.schema, fk.entity, pairs),
                columns: pairs.map(one => one.source),
                target: tableIdentity(storage.schema, fk.entity),
                pairs: pairs.map(one => ({...one})),
                deferrable: false,
                initiallyDeferred: false,
                validated: true,
                enforced: true,
            });
        }

        tables.push({
            schema: storage.schema,
            name: entityName,
            columns,
            primaryKey,
            uniqueKeys,
            foreignKeys,
        });
    }

    return {
        ok: true,
        value: {
            formatVersion: 1,
            engineVersion: "18.6",
            schemas: [storage.schema],
            objects,
            tables,
        },
    };
}

export async function checkPostgres18_6(
    session: PgSession,
): Promise<ValidationResult<{serverVersionNum: 180006}>> {
    let queryResult: Awaited<ReturnType<PgSession["query"]>>;
    try {
        queryResult = await session.query("SHOW server_version_num", []);
    } catch (error) {
        return fail("migration.environmentMismatch", {
            expected: "180006",
            actual: error instanceof Error ? error.message : String(error),
        });
    }

    if (queryResult.rows.length !== 1) {
        return fail("migration.environmentMismatch", {
            expected: "180006",
            actual: "query returned " + queryResult.rows.length + " rows",
        });
    }
    const raw = queryResult.rows[0]?.server_version_num;
    const numeric = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (numeric !== 180006) {
        return fail("migration.environmentMismatch", {expected: "180006", actual: String(raw)});
    }
    return {ok: true, value: {serverVersionNum: 180006}};
}

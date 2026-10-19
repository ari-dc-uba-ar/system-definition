import {decodePersistence, decodeSystemSnapshot, problem, sqlTypes, type PersistenceInfo, type SqlType, type SystemSnapshotInfo, type ValidationResult} from "system-definition";
import {projectSchema, resolvePhysicalTypes, type PgTypeRepresentation} from "./pg-schema";
import {decodePostgresStorage, type PostgresStorageInfo} from "./postgres-storage";

export type SqlSsotInfo = {ssot: SystemSnapshotInfo; persistence: PersistenceInfo & {representations: {postgres: Readonly<Record<string, SqlType>>}}; postgresStorage?: PostgresStorageInfo};
const pgType = (name: string): PgTypeRepresentation => ({schema: "pg_catalog", name, modifiers: []});
const physicalTypes: Readonly<Record<SqlType, PgTypeRepresentation>> = {
    [sqlTypes.text]: pgType("text"), [sqlTypes.varchar]: pgType("varchar"), [sqlTypes.boolean]: pgType("bool"),
    [sqlTypes.smallint]: pgType("int2"), [sqlTypes.integer]: pgType("int4"), [sqlTypes.bigint]: pgType("int8"),
    [sqlTypes.numeric]: pgType("numeric"), [sqlTypes.real]: pgType("float4"), [sqlTypes.doublePrecision]: pgType("float8"),
    [sqlTypes.date]: pgType("date"), [sqlTypes.time]: pgType("time"), [sqlTypes.timestamp]: pgType("timestamp"),
    [sqlTypes.timestampWithTimeZone]: pgType("timestamptz"), [sqlTypes.uuid]: pgType("uuid"),
    [sqlTypes.json]: pgType("json"), [sqlTypes.jsonb]: pgType("jsonb"), [sqlTypes.bytea]: pgType("bytea"),
};

function isSqlMapping(mapping: Readonly<Record<string, string>>): mapping is Readonly<Record<string, SqlType>> {
    return Object.values(mapping).every(type => Object.hasOwn(physicalTypes, type));
}

export function decodeSqlSsot(value: unknown, sqlMapping: unknown, postgresStorage?: unknown): ValidationResult<SqlSsotInfo> {
    const ssot = decodeSystemSnapshot(value);
    if (!ssot.ok) return ssot;
    const persistence = decodePersistence({entities: Object.keys(ssot.value.entities), representations: {postgres: sqlMapping}}, ssot.value);
    if (!persistence.ok) return persistence;
    const mapping = persistence.value.representations.postgres!;
    if (!isSqlMapping(mapping)) return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {reason: "Unknown SQL type; use the system-definition sqlTypes vocabulary"})]};
    const system: SqlSsotInfo = {ssot: ssot.value, persistence: {...persistence.value, representations: {postgres: mapping}}};
    if (postgresStorage === undefined) return {ok: true, value: system};
    const types = resolvePhysicalTypes(ssot.value, system.persistence, {representation: "postgres", physicalTypes});
    if (!types.ok) return types;
    const storage = decodePostgresStorage(postgresStorage, ssot.value, types.value);
    if (!storage.ok) return storage;
    const withStorage = {...system, postgresStorage: storage.value};
    const projection = projectSsotSchema(withStorage, "public");
    return projection.ok ? {ok: true, value: withStorage} : projection;
}

/** Direct projection of the supplied mapping; no logical-name or TypeScript-type guesses. */
export function projectSsotSchema(system: SqlSsotInfo, schema: string) {
    return projectSchema(system.ssot, system.persistence, {schema, representation: "postgres", physicalTypes, postgresStorage: system.postgresStorage});
}

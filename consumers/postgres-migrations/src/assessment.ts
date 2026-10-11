import type {SystemSnapshotInfo, ValidationResult} from "system-definition";
import {projectSchema, type PgSession, type PgTypeRepresentation} from "./pg-schema";
import {inspectSchema} from "./inspect-schema";
import {normalizePgSchema} from "./normalize-schema";
import {compareSchemas} from "./compare-schema";
import {classifySchemaDifferences, type SchemaClassificationInfo} from "./classify-schema";
import {connectPostgres} from "./pg-session";
import type {DatabaseSettings} from "./database-settings";

const physicalTypes: Record<string, PgTypeRepresentation> = {
    text: {schema: "pg_catalog", name: "text", modifiers: []},
    integer: {schema: "pg_catalog", name: "int4", modifiers: []},
    boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
};

export function projectSsotSchema(ssot: SystemSnapshotInfo, schema: string) {
    return projectSchema(ssot, {
        entities: Object.keys(ssot.entities),
        representations: {postgres: Object.fromEntries(ssot.typeNames.map(name => [name, name]))},
    }, {schema, representation: "postgres", physicalTypes});
}

/** Differences run from current database (before) to desired SSOT (after). */
export async function assessSchema(ssot: SystemSnapshotInfo, schema: string, session: PgSession): Promise<ValidationResult<SchemaClassificationInfo>> {
    const desired = projectSsotSchema(ssot, schema);
    if (!desired.ok) return desired;
    const observed = await inspectSchema(session, {schemas: [schema], excluded: []});
    if (!observed.ok) return observed;
    const current = await normalizePgSchema(observed.value.schema);
    const compared = compareSchemas(current, {...observed.value, schema: await normalizePgSchema(desired.value)});
    return compared.ok ? {ok: true, value: classifySchemaDifferences(compared.value)} : compared;
}

export async function assessDatabase(ssot: SystemSnapshotInfo, settings: DatabaseSettings): Promise<ValidationResult<SchemaClassificationInfo>> {
    const session = await connectPostgres({...settings.database, user: settings.appUser});
    try { return await assessSchema(ssot, settings.database.schema, session); }
    finally { await session.close(); }
}

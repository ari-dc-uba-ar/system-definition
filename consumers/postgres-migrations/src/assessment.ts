import type {ValidationResult} from "system-definition";
import type {PgSession} from "./pg-schema";
import {inspectSchema} from "./inspect-schema";
import {normalizePgSchema} from "./normalize-schema";
import {compareSchemas} from "./compare-schema";
import {classifySchemaDifferences, type SchemaClassificationInfo} from "./classify-schema";
import {connectPostgres} from "./pg-session";
import type {DatabaseSettings} from "./database-settings";
import {projectSsotSchema, type SqlSsotInfo} from "./sql-mapping";

/** Differences run from current database (before) to desired SSOT (after). */
export async function assessSchema(ssot: SqlSsotInfo, schema: string, session: PgSession): Promise<ValidationResult<SchemaClassificationInfo>> {
    const desired = projectSsotSchema(ssot, schema);
    if (!desired.ok) return desired;
    const observed = await inspectSchema(session, {schemas: [schema], excluded: []});
    if (!observed.ok) return observed;
    const current = await normalizePgSchema(observed.value.schema);
    const compared = compareSchemas(current, {...observed.value, schema: await normalizePgSchema(desired.value)});
    return compared.ok ? {ok: true, value: classifySchemaDifferences(compared.value)} : compared;
}

export async function assessDatabase(ssot: SqlSsotInfo, settings: DatabaseSettings): Promise<ValidationResult<SchemaClassificationInfo>> {
    const session = await connectPostgres({...settings.database, ...settings.appUser});
    try { return await assessSchema(ssot, settings.database.schema, session); }
    finally { await session.close(); }
}

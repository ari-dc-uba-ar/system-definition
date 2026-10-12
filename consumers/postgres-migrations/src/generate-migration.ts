import type {ValidationResult} from "system-definition";
import type {StructureChangeInfo} from "./authoring-contract";
import {generateStructureSql, type StructureSql} from "./generate-structure";
import type {PgSchemaInfo} from "./pg-schema";
import {projectSsotSchema, type SqlSsotInfo} from "./sql-mapping";

/** Render resolved changes using the backend's explicit SQL mapping. No DB or execution. */
export function generateMigrationSql(changes: readonly StructureChangeInfo[], current: PgSchemaInfo, target: SqlSsotInfo, schema: string, dataDestinations: ReadonlySet<string> = new Set()): ValidationResult<readonly StructureSql[]> {
    const desired = projectSsotSchema(target, schema);
    return desired.ok ? generateStructureSql(changes, current, desired.value, dataDestinations) : desired;
}

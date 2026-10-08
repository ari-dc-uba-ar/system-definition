import {loadModule, parseSync, deparseSync} from "pgsql-parser";
import type {PgSchemaInfo} from "./pg-schema";
import {quotePgQualified, quotePgIdentifier} from "./pg-sql";

/** PostgreSQL's printer omits unnecessary identifier quotes; compare parsed definitions. */
export async function normalizePgSchema(schema: PgSchemaInfo): Promise<PgSchemaInfo> {
    await loadModule();
    return {...schema, objects: schema.objects.map(object => {
        if (object.kind === "column" && object.type.collation === "pg_catalog.default") {
            return {...object, type: {...object.type, collation: null}};
        }
        if (object.kind === "constraint") {
            const table = quotePgQualified(object.identity.schema, object.identity.parentName!);
            const name = quotePgIdentifier(object.identity.name);
            return {...object, definition: deparseSync(parseSync(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${object.definition}`))};
        }
        return object;
    })};
}

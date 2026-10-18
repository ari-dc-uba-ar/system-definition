import {loadModule, parseSync, deparseSync} from "pgsql-parser";
import type {PgSchemaInfo} from "./pg-schema";
import {quotePgQualified, quotePgIdentifier} from "./pg-sql";
import {isPlainObject} from "system-definition";

function isStringLiteral(value: unknown): boolean {
    if (!isPlainObject(value)) return false;
    if (isPlainObject(value.A_Const)) return Object.hasOwn(value.A_Const, "sval") || value.A_Const.isnull === true;
    const cast = value.TypeCast;
    if (!isPlainObject(cast) || !isPlainObject(cast.typeName) || !Array.isArray(cast.typeName.names)
        || (Array.isArray(cast.typeName.arrayBounds) && cast.typeName.arrayBounds.length > 0)) return false;
    const names = cast.typeName.names.map(name => isPlainObject(name) && isPlainObject(name.String) ? name.String.sval : null);
    const name = names.length === 1 ? names[0] : names.length === 2 && names[0] === "pg_catalog" ? names[1] : null;
    return ["text", "varchar", "bpchar"].includes(String(name)) && isStringLiteral(cast.arg);
}

/** PostgreSQL can push a text[] cast on a one-dimensional ARRAY into each element. */
function normalizeTextArrayCasts(value: unknown): void {
    if (Array.isArray(value)) {
        for (const child of value) normalizeTextArrayCasts(child);
        return;
    }
    if (!isPlainObject(value)) return;
    for (const child of Object.values(value)) normalizeTextArrayCasts(child);
    normalizeArrayCast(value);
}

function normalizeArrayCast(value: Record<string, unknown>): void {
    const cast = value.TypeCast;
    if (!isPlainObject(cast) || !isPlainObject(cast.arg) || !isPlainObject(cast.typeName)) return;
    const array = cast.arg.A_ArrayExpr;
    const type = cast.typeName;
    if (!isPlainObject(array) || !Array.isArray(array.elements) || !Array.isArray(type.names)
        || !Array.isArray(type.arrayBounds) || type.arrayBounds.length !== 1
        || (Array.isArray(type.typmods) && type.typmods.length > 0)) return;
    const names = type.names.map(name => isPlainObject(name) && isPlainObject(name.String) ? name.String.sval : null);
    if (!(names.length === 1 && names[0] === "text") && !(names.length === 2 && names[0] === "pg_catalog" && names[1] === "text")) return;
    if (!array.elements.every(isStringLiteral)) return;
    const scalarType = {...type};
    delete scalarType.arrayBounds;
    delete value.TypeCast;
    value.A_ArrayExpr = {...array, elements: array.elements.map(element => ({TypeCast: {arg: element, typeName: scalarType}}))};
}

function normalizedDefinition(sql: string): string {
    const tree = parseSync(sql);
    normalizeTextArrayCasts(tree);
    return deparseSync(tree);
}

/** PostgreSQL's printer omits unnecessary identifier quotes; compare parsed definitions. */
export async function normalizePgSchema(schema: PgSchemaInfo): Promise<PgSchemaInfo> {
    await loadModule();
    // Constraint backing indexes are represented by their owning constraints.
    return {...schema, objects: schema.objects.filter(object => object.kind !== "index" || object.ownerConstraint === null).map(object => {
        if (object.kind === "column" && object.type.collation === "pg_catalog.default") {
            return {...object, type: {...object.type, collation: null}};
        }
        if (object.kind === "constraint") {
            const table = quotePgQualified(object.identity.schema, object.identity.parentName!);
            const name = quotePgIdentifier(object.identity.name);
            const definition = /^\s*ALTER\s+TABLE\b/i.test(object.definition)
                ? object.definition : `ALTER TABLE ${table} ADD CONSTRAINT ${name} ${object.definition}`;
            return {...object, definition: normalizedDefinition(definition)};
        }
        if (object.kind === "index") return {...object, definition: normalizedDefinition(object.definition)};
        return object;
    })};
}

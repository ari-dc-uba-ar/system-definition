import {problem, type ValidationResult} from "system-definition";
import type {
    PgObjectIdentity,
    PgObjectInfo,
    PgSchemaInfo,
    PgSession,
    SqlParameter,
} from "./pg-schema";

export type InspectionScope = {
    schemas: readonly string[];
    excluded: readonly {object: PgObjectIdentity; reason: string}[];
};

export type InspectionInfo = {
    schema: PgSchemaInfo;
    unknown: readonly {object: PgObjectIdentity; feature: string}[];
    excluded: readonly {object: PgObjectIdentity; reason: string}[];
};

type CatalogRow = Readonly<Record<string, unknown>>;

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function utf16Compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function identityKey(identity: PgObjectIdentity): string {
    return JSON.stringify([
        identity.schema,
        identity.kind,
        identity.parentName,
        identity.name,
        [...identity.signature],
    ]);
}

function compareIdentity(left: PgObjectIdentity, right: PgObjectIdentity): number {
    return utf16Compare(identityKey(left), identityKey(right));
}

function sameIdentity(left: PgObjectIdentity, right: PgObjectIdentity): boolean {
    return identityKey(left) === identityKey(right);
}

function stringValue(row: CatalogRow, key: string): string | null {
    const value = row[key];
    return typeof value === "string" ? value : null;
}

function nullableStringValue(row: CatalogRow, key: string): string | null | undefined {
    const value = row[key];
    return value === null ? null : typeof value === "string" ? value : undefined;
}

function booleanValue(row: CatalogRow, key: string): boolean | null {
    const value = row[key];
    return typeof value === "boolean" ? value : null;
}

function numberValue(row: CatalogRow, key: string): number | null {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayValue(row: CatalogRow, key: string): readonly string[] | null {
    const value = row[key];
    if (!Array.isArray(value) || value.some(one => typeof one !== "string")) return null;
    return [...value] as string[];
}

function signatureValue(row: CatalogRow): readonly string[] | null {
    const value = row.signature;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some(one => typeof one !== "string")) return null;
    return [...value] as string[];
}

function identityFromRow(row: CatalogRow): PgObjectIdentity | null {
    const schema = stringValue(row, "schema_name");
    const kind = stringValue(row, "object_kind");
    const name = stringValue(row, "object_name");
    const parent = nullableStringValue(row, "parent_name");
    const signature = signatureValue(row);
    if (schema === null || schema.length === 0
        || kind === null || kind.length === 0
        || name === null || name.length === 0
        || parent === undefined || signature === null) {
        return null;
    }
    return {schema, kind, name, parentName: parent, signature};
}

function normalizePersistence(value: string): string {
    if (value === "p") return "permanent";
    if (value === "u") return "unlogged";
    if (value === "t") return "temporary";
    return value;
}

function tableObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    const persistence = stringValue(row, "persistence");
    const relationKind = stringValue(row, "relation_kind");
    if (persistence === null || relationKind === null) return null;
    return {
        kind: "table",
        identity: {...identity, kind: "table"},
        persistence: normalizePersistence(persistence),
        relationKind,
    };
}

function columnObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    const typeSchema = stringValue(row, "type_schema");
    const typeName = stringValue(row, "type_name");
    const modifiers = stringArrayValue(row, "type_modifiers");
    const arrayDimensions = numberValue(row, "array_dimensions");
    const collation = nullableStringValue(row, "collation");
    const nullable = booleanValue(row, "nullable");
    const defaultExpression = nullableStringValue(row, "default_expression");
    const identityDefinition = nullableStringValue(row, "identity_definition");
    const generatedDefinition = nullableStringValue(row, "generated_definition");
    if (typeSchema === null || typeName === null || modifiers === null || arrayDimensions === null
        || !Number.isInteger(arrayDimensions) || arrayDimensions < 0 || collation === undefined
        || nullable === null || defaultExpression === undefined || identityDefinition === undefined
        || generatedDefinition === undefined) {
        return null;
    }
    return {
        kind: "column",
        identity: {...identity, kind: "column"},
        type: {
            schema: typeSchema,
            name: typeName,
            modifiers,
            arrayDimensions,
            collation,
        },
        nullable,
        defaultExpression,
        identityDefinition,
        generatedDefinition,
    };
}

function pairArrayValue(row: CatalogRow): readonly {source: string; target: string}[] | null {
    const value = row.pairs;
    if (!Array.isArray(value)) return null;
    const result: {source: string; target: string}[] = [];
    for (const one of value) {
        if (typeof one !== "object" || one === null || Array.isArray(one)) return null;
        const source = Reflect.get(one, "source");
        const target = Reflect.get(one, "target");
        if (typeof source !== "string" || typeof target !== "string") return null;
        result.push({source, target});
    }
    return result;
}

function constraintObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    const constraintKind = stringValue(row, "constraint_kind");
    if (constraintKind !== "primaryKey" && constraintKind !== "unique"
        && constraintKind !== "foreignKey" && constraintKind !== "check") return null;
    const definition = stringValue(row, "definition");
    const columns = stringArrayValue(row, "columns");
    const pairs = pairArrayValue(row);
    const deferrable = booleanValue(row, "deferrable");
    const initiallyDeferred = booleanValue(row, "initially_deferred");
    const validated = booleanValue(row, "validated");
    const enforced = booleanValue(row, "enforced");
    if (definition === null || columns === null || pairs === null || deferrable === null
        || initiallyDeferred === null || validated === null || enforced === null) return null;

    const targetSchema = nullableStringValue(row, "target_schema");
    const targetName = nullableStringValue(row, "target_name");
    if (targetSchema === undefined || targetName === undefined) return null;
    let target: PgObjectIdentity | null = null;
    if (constraintKind === "foreignKey") {
        if (targetSchema === null || targetName === null) return null;
        target = {schema: targetSchema, kind: "table", name: targetName, parentName: null, signature: []};
    } else if (targetSchema !== null || targetName !== null || pairs.length !== 0) {
        return null;
    }

    return {
        kind: "constraint",
        identity: {...identity, kind: "constraint"},
        constraintKind,
        definition,
        columns,
        target,
        pairs,
        deferrable,
        initiallyDeferred,
        validated,
        enforced,
    };
}

function indexObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    const definition = stringValue(row, "definition");
    const valid = booleanValue(row, "valid");
    const ready = booleanValue(row, "ready");
    const ownerSchema = nullableStringValue(row, "owner_constraint_schema");
    const ownerName = nullableStringValue(row, "owner_constraint_name");
    const ownerParent = nullableStringValue(row, "owner_constraint_parent");
    if (definition === null || valid === null || ready === null
        || ownerSchema === undefined || ownerName === undefined || ownerParent === undefined) return null;
    let ownerConstraint: PgObjectIdentity | null = null;
    if (ownerSchema !== null || ownerName !== null || ownerParent !== null) {
        if (ownerSchema === null || ownerName === null || ownerParent === null) return null;
        ownerConstraint = {
            schema: ownerSchema,
            kind: "constraint",
            name: ownerName,
            parentName: ownerParent,
            signature: [],
        };
    }
    return {kind: "index", identity: {...identity, kind: "index"}, definition, valid, ready, ownerConstraint};
}

function optionsValue(row: CatalogRow): Readonly<Record<string, string>> | null {
    const value = row.options;
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, option] of Object.entries(value)) {
        if (typeof option !== "string") return null;
        result[key] = option;
    }
    return result;
}

function viewObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    const definition = stringValue(row, "definition");
    const columns = stringArrayValue(row, "columns");
    const options = optionsValue(row);
    if (definition === null || columns === null || options === null) return null;
    return {kind: "view", identity: {...identity, kind: "view"}, definition, columns, options};
}

function routineObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    const definition = stringValue(row, "definition");
    const routineKind = stringValue(row, "routine_kind");
    if (definition === null || (routineKind !== "function" && routineKind !== "procedure")) return null;
    return {kind: "routine", identity: {...identity, kind: "routine"}, routineKind, definition};
}

function supportedObject(row: CatalogRow, identity: PgObjectIdentity): PgObjectInfo | null {
    switch (identity.kind) {
    case "table": return tableObject(row, identity);
    case "column": return columnObject(row, identity);
    case "constraint": return constraintObject(row, identity);
    case "index": return indexObject(row, identity);
    case "view": return viewObject(row, identity);
    case "routine": return routineObject(row, identity);
    default: return null;
    }
}

function scopeSql(schemaCount: number): string {
    const parameters = Array.from({length: schemaCount}, (_, index) => "$" + (index + 1)).join(", ");
    // One inventory query keeps every catalog read on the caller's session, so uncommitted DDL
    // is visible. Catalog OIDs are used only to join/deparse and are deliberately not selected.
    return `
WITH managed_schemas AS (
    SELECT n.oid, n.nspname
      FROM pg_catalog.pg_namespace AS n
     WHERE n.nspname IN (${parameters})
), relations AS (
    SELECT 'table'::text AS object_kind,
           n.nspname AS schema_name,
           c.relname AS object_name,
           NULL::text AS parent_name,
           ARRAY[]::text[] AS signature,
           c.relpersistence::text AS persistence,
           c.relkind::text AS relation_kind,
           NULL::text AS type_schema, NULL::text AS type_name,
           ARRAY[]::text[] AS type_modifiers, NULL::integer AS array_dimensions,
           NULL::text AS collation, NULL::boolean AS nullable,
           NULL::text AS default_expression, NULL::text AS identity_definition,
           NULL::text AS generated_definition, NULL::text AS constraint_kind,
           NULL::text AS definition, ARRAY[]::text[] AS columns,
           NULL::text AS target_schema, NULL::text AS target_name,
           '[]'::jsonb AS pairs, NULL::boolean AS deferrable,
           NULL::boolean AS initially_deferred, NULL::boolean AS validated,
           NULL::boolean AS enforced, NULL::boolean AS valid, NULL::boolean AS ready,
           NULL::text AS owner_constraint_schema, NULL::text AS owner_constraint_name,
           NULL::text AS owner_constraint_parent, NULL::jsonb AS options,
           NULL::text AS routine_kind, NULL::text AS feature
      FROM pg_catalog.pg_class AS c
      JOIN managed_schemas AS n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p')
), columns_inventory AS (
    SELECT 'column'::text, n.nspname, a.attname, c.relname, ARRAY[]::text[],
           NULL::text, NULL::text,
           tn.nspname, t.typname, ARRAY[]::text[], GREATEST(a.attndims, 0),
           CASE WHEN a.attcollation = 0 THEN NULL ELSE cn.nspname || '.' || co.collname END,
           NOT a.attnotnull,
           pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true),
           NULLIF(a.attidentity::text, ''), NULLIF(a.attgenerated::text, ''),
           NULL::text, NULL::text, ARRAY[]::text[], NULL::text, NULL::text,
           '[]'::jsonb, NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
           NULL::boolean, NULL::boolean, NULL::text, NULL::text, NULL::text,
           NULL::jsonb, NULL::text, NULL::text
      FROM pg_catalog.pg_attribute AS a
      JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
      JOIN managed_schemas AS n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
      JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_attrdef AS ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_collation AS co ON co.oid = a.attcollation
      LEFT JOIN pg_catalog.pg_namespace AS cn ON cn.oid = co.collnamespace
     WHERE c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
), constraints_inventory AS (
    SELECT 'constraint'::text, n.nspname, con.conname, c.relname, ARRAY[]::text[],
           NULL::text, NULL::text, NULL::text, NULL::text, ARRAY[]::text[], NULL::integer,
           NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text,
           CASE con.contype WHEN 'p' THEN 'primaryKey' WHEN 'u' THEN 'unique'
                            WHEN 'f' THEN 'foreignKey' WHEN 'c' THEN 'check' END,
           pg_catalog.pg_get_constraintdef(con.oid, true),
           ARRAY(
               SELECT a.attname
                 FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
                 JOIN pg_catalog.pg_attribute AS a
                   ON a.attrelid = con.conrelid AND a.attnum = key.attnum
                ORDER BY key.ordinal
           ),
           tn.nspname, tc.relname,
           CASE WHEN con.contype = 'f' THEN COALESCE((
               SELECT pg_catalog.jsonb_agg(
                          pg_catalog.jsonb_build_object('source', sa.attname, 'target', ta.attname)
                          ORDER BY source_key.ordinal
                      )
                 FROM unnest(con.conkey) WITH ORDINALITY AS source_key(attnum, ordinal)
                 JOIN unnest(con.confkey) WITH ORDINALITY AS target_key(attnum, ordinal)
                   ON target_key.ordinal = source_key.ordinal
                 JOIN pg_catalog.pg_attribute AS sa
                   ON sa.attrelid = con.conrelid AND sa.attnum = source_key.attnum
                 JOIN pg_catalog.pg_attribute AS ta
                   ON ta.attrelid = con.confrelid AND ta.attnum = target_key.attnum
           ), '[]'::jsonb) ELSE '[]'::jsonb END,
           con.condeferrable, con.condeferred, con.convalidated, con.conenforced,
           NULL::boolean, NULL::boolean, NULL::text, NULL::text, NULL::text,
           NULL::jsonb, NULL::text, NULL::text
      FROM pg_catalog.pg_constraint AS con
      JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
      JOIN managed_schemas AS n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_class AS tc ON tc.oid = con.confrelid AND con.contype = 'f'
      LEFT JOIN pg_catalog.pg_namespace AS tn ON tn.oid = tc.relnamespace
     WHERE con.contype IN ('p','u','f','c')
), indexes_inventory AS (
    SELECT 'index'::text, n.nspname, idx.relname, tbl.relname, ARRAY[]::text[],
           NULL::text, NULL::text, NULL::text, NULL::text, ARRAY[]::text[], NULL::integer,
           NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text,
           NULL::text, pg_catalog.pg_get_indexdef(i.indexrelid, 0, true), ARRAY[]::text[],
           NULL::text, NULL::text, '[]'::jsonb,
           NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
           i.indisvalid, i.indisready,
           owner_ns.nspname, owner_con.conname, owner_tbl.relname,
           NULL::jsonb, NULL::text, NULL::text
      FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS idx ON idx.oid = i.indexrelid
      JOIN pg_catalog.pg_class AS tbl ON tbl.oid = i.indrelid
      JOIN managed_schemas AS n ON n.oid = tbl.relnamespace
      LEFT JOIN pg_catalog.pg_constraint AS owner_con ON owner_con.conindid = i.indexrelid
      LEFT JOIN pg_catalog.pg_class AS owner_tbl ON owner_tbl.oid = owner_con.conrelid
      LEFT JOIN pg_catalog.pg_namespace AS owner_ns ON owner_ns.oid = owner_tbl.relnamespace
), unsupported_triggers AS (
    SELECT 'trigger'::text, n.nspname, t.tgname, c.relname, ARRAY[]::text[],
           NULL::text, NULL::text, NULL::text, NULL::text, ARRAY[]::text[], NULL::integer,
           NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text,
           NULL::text, NULL::text, ARRAY[]::text[], NULL::text, NULL::text, '[]'::jsonb,
           NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean,
           NULL::boolean, NULL::boolean, NULL::text, NULL::text, NULL::text,
           NULL::jsonb, NULL::text, 'trigger'::text
      FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
      JOIN managed_schemas AS n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
)
SELECT * FROM relations
UNION ALL SELECT * FROM columns_inventory
UNION ALL SELECT * FROM constraints_inventory
UNION ALL SELECT * FROM indexes_inventory
UNION ALL SELECT * FROM unsupported_triggers
ORDER BY schema_name, object_kind, parent_name NULLS FIRST, object_name
`;
}

export async function inspectSchema(
    session: PgSession,
    scope: InspectionScope,
): Promise<ValidationResult<InspectionInfo>> {
    if (scope.schemas.length === 0 || scope.schemas.some(schema => schema.length === 0)) {
        return fail("migration.unsupportedFormat", {reason: "inspection scope requires non-empty schema names"});
    }
    if (new Set(scope.schemas).size !== scope.schemas.length) {
        return fail("migration.unsupportedFormat", {reason: "inspection scope schemas must not repeat"});
    }

    let queried: Awaited<ReturnType<PgSession["query"]>>;
    try {
        queried = await session.query(scopeSql(scope.schemas.length), [...scope.schemas] as SqlParameter[]);
    } catch (error) {
        return fail("migration.inspectionFailed", {
            reason: error instanceof Error ? error.message : String(error),
        });
    }

    const objects: PgObjectInfo[] = [];
    const unknown: {object: PgObjectIdentity; feature: string}[] = [];
    const excluded: {object: PgObjectIdentity; reason: string}[] = [];
    const seen = new Set<string>();

    for (const row of queried.rows) {
        const identity = identityFromRow(row);
        if (identity === null || !scope.schemas.includes(identity.schema)) {
            return fail("migration.unsupportedSchemaFeature", {reason: "catalog inventory row has an invalid identity"});
        }
        const exclusion = scope.excluded.find(one => sameIdentity(one.object, identity));
        if (exclusion !== undefined) {
            if (!excluded.some(one => sameIdentity(one.object, exclusion.object))) {
                excluded.push({object: {...exclusion.object, signature: [...exclusion.object.signature]}, reason: exclusion.reason});
            }
            continue;
        }

        const key = identityKey(identity);
        if (seen.has(key)) {
            return fail("migration.unsupportedSchemaFeature", {object: key, reason: "duplicate catalog identity"});
        }
        seen.add(key);

        const object = supportedObject(row, identity);
        if (object === null) {
            unknown.push({
                object: {...identity, signature: [...identity.signature]},
                feature: stringValue(row, "feature") ?? identity.kind,
            });
            continue;
        }
        objects.push(object);
    }

    objects.sort((left, right) => compareIdentity(left.identity, right.identity));
    unknown.sort((left, right) => compareIdentity(left.object, right.object));
    excluded.sort((left, right) => compareIdentity(left.object, right.object));

    return {
        ok: true,
        value: {
            schema: {
                formatVersion: 1,
                engineVersion: "18.6",
                schemas: [...scope.schemas].sort(utf16Compare),
                objects,
            },
            unknown,
            excluded,
        },
    };
}

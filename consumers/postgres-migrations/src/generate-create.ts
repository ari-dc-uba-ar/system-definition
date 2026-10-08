import {compareUtf16, problem, type ValidationResult} from "system-definition";
import {pgIdentityKey} from "./pg-identity";
import {
    quotePgIdentifier,
    type PgObjectIdentity,
    type PgObjectInfo,
    type PgSchemaInfo,
    type PgTypeInfo,
    type SqlParameter,
} from "./pg-schema";

export type CreateSqlPhase = "table" | "local-constraint" | "foreign-key";

export type CreateSqlStatement = {
    phase: CreateSqlPhase;
    text: string;
    values: readonly SqlParameter[];
};

export type CreateSqlPlan = {
    formatVersion: 1;
    schema: string;
    statements: readonly CreateSqlStatement[];
};

function fail<T>(messageKey: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

/**
 * Clean-create output historically orders the semantic identity fields directly.
 * Keep that SQL-generation policy explicit: comparePgIdentity orders the JSON key
 * representation and can differ for legal quoted identifiers.
 */
function compareCreateIdentity(left: PgObjectIdentity, right: PgObjectIdentity): number {
    const leftParts = [left.schema, left.kind, left.parentName ?? "", left.name, ...left.signature];
    const rightParts = [right.schema, right.kind, right.parentName ?? "", right.name, ...right.signature];
    const length = Math.min(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index++) {
        const compared = compareUtf16(leftParts[index], rightParts[index]);
        if (compared !== 0) return compared;
    }
    return leftParts.length - rightParts.length;
}

function qualified(schema: string, name: string): string {
    return quotePgIdentifier(schema) + "." + quotePgIdentifier(name);
}

export function renderPgType(type: PgTypeInfo): string {
    const base = qualified(type.schema, type.name);
    const modifiers = type.modifiers.length === 0 ? "" : "(" + type.modifiers.join(", ") + ")";
    const arrays = "[]".repeat(type.arrayDimensions);
    const collationParts = type.collation?.split(".");
    const collation = type.collation === null || type.collation === "pg_catalog.default" ? ""
        : " COLLATE " + (collationParts?.length === 2 ? qualified(collationParts[0]!, collationParts[1]!) : qualified(type.schema, type.collation));
    return base + modifiers + arrays + collation;
}

function columnsOf(objects: readonly PgObjectInfo[], table: PgObjectIdentity): Extract<PgObjectInfo, {kind: "column"}>[] {
    return objects
        .filter((one): one is Extract<PgObjectInfo, {kind: "column"}> => one.kind === "column"
            && one.identity.schema === table.schema
            && one.identity.parentName === table.name)
        .sort((a, b) => compareCreateIdentity(a.identity, b.identity));
}

export function constraintSql(object: Extract<PgObjectInfo, {kind: "constraint"}>): ValidationResult<string> {
    const table = object.identity.parentName;
    if (table === null) {
        return fail("migration.unsupportedFormat", {constraint: object.identity.name, reason: "constraint has no parent table"});
    }
    const tableName = qualified(object.identity.schema, table);
    const constraint = quotePgIdentifier(object.identity.name);
    if (object.constraintKind === "primaryKey") {
        return {ok: true, value: "ALTER TABLE " + tableName + " ADD CONSTRAINT " + constraint
            + " PRIMARY KEY (" + object.columns.map(quotePgIdentifier).join(", ") + ")"};
    }
    if (object.constraintKind === "unique") {
        return {ok: true, value: "ALTER TABLE " + tableName + " ADD CONSTRAINT " + constraint
            + " UNIQUE (" + object.columns.map(quotePgIdentifier).join(", ") + ")"};
    }
    if (object.constraintKind === "foreignKey") {
        if (object.target === null || object.pairs.length === 0) {
            return fail("migration.unsupportedFormat", {constraint: object.identity.name, reason: "foreign key target/pairs are missing"});
        }
        return {
            ok: true,
            value: "ALTER TABLE " + tableName + " ADD CONSTRAINT " + constraint
                + " FOREIGN KEY (" + object.pairs.map(one => quotePgIdentifier(one.source)).join(", ") + ")"
                + " REFERENCES " + qualified(object.target.schema, object.target.name)
                + " (" + object.pairs.map(one => quotePgIdentifier(one.target)).join(", ") + ")",
        };
    }
    return fail("migration.unsupportedSchemaFeature", {constraint: object.identity.name, reason: "generated CHECK constraints are not supported"});
}

export function generateCreate(schema: PgSchemaInfo): ValidationResult<CreateSqlPlan> {
    if (schema.formatVersion !== 1 || schema.engineVersion !== "18.6") {
        return fail("migration.unsupportedFormat", {reason: "unsupported PostgreSQL schema format/version"});
    }
    if (schema.schemas.length !== 1) {
        return fail("migration.unsupportedSchemaFeature", {reason: "clean create currently requires exactly one managed schema"});
    }

    const identities = new Set<string>();
    for (const object of schema.objects) {
        const key = pgIdentityKey(object.identity);
        if (identities.has(key)) {
            return fail("migration.unsupportedFormat", {reason: "duplicate PostgreSQL object identity", object: key});
        }
        identities.add(key);
        if (object.kind === "index" || object.kind === "view" || object.kind === "routine") {
            return fail("migration.unsupportedSchemaFeature", {
                kind: object.kind,
                object: object.identity.name,
                reason: "object must be created by an explicit create resource",
            });
        }
    }

    const tables = schema.objects
        .filter((one): one is Extract<PgObjectInfo, {kind: "table"}> => one.kind === "table")
        .sort((a, b) => compareCreateIdentity(a.identity, b.identity));
    const constraints = schema.objects
        .filter((one): one is Extract<PgObjectInfo, {kind: "constraint"}> => one.kind === "constraint")
        .sort((a, b) => compareCreateIdentity(a.identity, b.identity));

    const statements: CreateSqlStatement[] = [];
    for (const table of tables) {
        const columns = columnsOf(schema.objects, table.identity);
        if (columns.length === 0) {
            return fail("migration.unsupportedSchemaFeature", {table: table.identity.name, reason: "table has no columns"});
        }
        const definitions = columns.map(column => quotePgIdentifier(column.identity.name) + " " + renderPgType(column.type)
            + (column.nullable ? "" : " NOT NULL"));
        statements.push({
            phase: "table",
            text: "CREATE TABLE " + qualified(table.identity.schema, table.identity.name) + " (" + definitions.join(", ") + ")",
            values: [],
        });
    }

    for (const constraint of constraints.filter(one => one.constraintKind !== "foreignKey")) {
        const sql = constraintSql(constraint);
        if (!sql.ok) return sql;
        statements.push({phase: "local-constraint", text: sql.value, values: []});
    }
    for (const constraint of constraints.filter(one => one.constraintKind === "foreignKey")) {
        const sql = constraintSql(constraint);
        if (!sql.ok) return sql;
        statements.push({phase: "foreign-key", text: sql.value, values: []});
    }

    return {
        ok: true,
        value: {
            formatVersion: 1,
            schema: schema.schemas[0],
            statements,
        },
    };
}

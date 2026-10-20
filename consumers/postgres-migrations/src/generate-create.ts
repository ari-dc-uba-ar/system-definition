import {compareUtf16, problem, type ValidationResult} from "system-definition";
import {pgIdentityKey} from "./pg-identity";
import {POSTGRES_SUPPORT} from "./postgres-support";
import {readSingleSqlStatement, type SqlSyntaxToken} from "./sql-resource";
import {constraintTimingSql,
    quotePgIdentifier,
    quotePgQualified as qualified,
} from "./pg-sql";
import type {
    PgObjectIdentity,
    PgObjectInfo,
    PgSchemaInfo,
    PgTypeInfo,
    SqlParameter,
} from "./pg-schema";

export type CreateSqlPhase = "table" | "local-constraint" | "index" | "foreign-key";

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

export function renderPgType(type: PgTypeInfo): string {
    const base = qualified(type.schema, type.name);
    const modifiers = type.modifiers.length === 0 ? "" : "(" + type.modifiers.join(", ") + ")";
    const arrays = "[]".repeat(type.arrayDimensions);
    const collationParts = type.collation?.split(".");
    const collation = type.collation === null || type.collation === "pg_catalog.default" ? ""
        : " COLLATE " + (collationParts?.length === 2 ? qualified(collationParts[0]!, collationParts[1]!) : qualified(type.schema, type.collation));
    return base + modifiers + arrays + collation;
}

export function columnDefinitionSql(column: Extract<PgObjectInfo, {kind: "column"}>): ValidationResult<string> {
    if (column.generatedDefinition !== null) return fail("migration.unsupportedSchemaFeature", {column: column.identity.name, reason: "Generated expressions require explicit SQL"});
    let identity = "";
    if (column.identityDefinition !== null) {
        if (!["a", "d"].includes(column.identityDefinition) || column.nullable || column.defaultExpression !== null
            || column.type.schema !== "pg_catalog" || !["int2", "int4", "int8"].includes(column.type.name)
            || column.type.arrayDimensions !== 0 || column.type.modifiers.length !== 0) {
            return fail("migration.unsupportedSchemaFeature", {column: column.identity.name, reason: "Unsupported identity attributes"});
        }
        identity = ` GENERATED ${column.identityDefinition === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
    }
    return {ok: true, value: renderPgType(column.type)
        + identity
        + (column.defaultExpression === null ? "" : ` DEFAULT ${column.defaultExpression}`)
        + (column.nullable ? "" : " NOT NULL")};
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
    if (!object.validated || !object.enforced || (object.initiallyDeferred && !object.deferrable)) return fail("migration.unsupportedSchemaFeature", {constraint: object.identity.name, reason: "These constraint attributes require explicit SQL"});
    const timing = constraintTimingSql(object.deferrable, object.initiallyDeferred);
    if (object.constraintKind === "primaryKey" || object.constraintKind === "unique") {
        return {ok: true, value: "ALTER TABLE " + tableName + " ADD CONSTRAINT " + constraint
            + (object.constraintKind === "primaryKey" ? " PRIMARY KEY (" : " UNIQUE (")
            + object.columns.map(quotePgIdentifier).join(", ") + ")" + timing};
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
                + " (" + object.pairs.map(one => quotePgIdentifier(one.target)).join(", ") + ")" + timing,
        };
    }
    const checked = readSingleSqlStatement(object.definition);
    if (!checked.ok) return checked;
    const tokens = checked.value.tokens;
    const complete = word(tokens[0], "alter") && word(tokens[1], "table")
        && identifier(tokens[2], object.identity.schema) && symbol(tokens[3], ".") && identifier(tokens[4], table)
        && word(tokens[5], "add") && word(tokens[6], "constraint") && identifier(tokens[7], object.identity.name);
    if (object.deferrable || object.target !== null || object.pairs.length !== 0 || !isCheckDefinition(complete ? tokens.slice(8) : tokens)) {
        return fail("migration.unsupportedSchemaFeature", {constraint: object.identity.name, reason: "Unsupported CHECK definition or attributes"});
    }
    return {ok: true, value: complete ? checked.value.text : `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraint} ${checked.value.text}`};
}

function word(token: SqlSyntaxToken | undefined, expected: string): boolean {
    return token?.kind === "word" && token.text === expected;
}

function identifier(token: SqlSyntaxToken | undefined, expected: string): boolean {
    return (token?.kind === "word" || token?.kind === "identifier") && token.text === expected;
}

function symbol(token: SqlSyntaxToken | undefined, expected: string): boolean {
    return token?.kind === "symbol" && token.text === expected;
}

function isCheckDefinition(tokens: readonly SqlSyntaxToken[]): boolean {
    if (!word(tokens[0], "check") || !symbol(tokens[1], "(")) return false;
    let depth = 0;
    for (let index = 1; index < tokens.length; index++) {
        if (symbol(tokens[index], "(")) depth++;
        if (symbol(tokens[index], ")")) depth--;
        if (depth === 0) {
            const tail = tokens.slice(index + 1);
            return index > 2 && (tail.length === 0 || (tail.length === 2 && word(tail[0], "no") && word(tail[1], "inherit")));
        }
    }
    return false;
}

/** Bind the single CREATE INDEX statement to its recorded index and parent identities. */
export function indexSql(object: Extract<PgObjectInfo, {kind: "index"}>): ValidationResult<string> {
    if (!object.valid || !object.ready || object.ownerConstraint !== null || object.identity.parentName === null) {
        return fail("migration.unsupportedSchemaFeature", {index: object.identity.name, reason: "Only valid ready independent indexes can be generated"});
    }
    const checked = readSingleSqlStatement(object.definition);
    if (!checked.ok) return checked;
    const tokens = checked.value.tokens;
    let position = 0;
    if (!word(tokens[position++], "create")) return invalidIndex(object);
    const unique = word(tokens[position], "unique");
    if (unique) position++;
    if (!word(tokens[position++], "index") || !identifier(tokens[position++], object.identity.name)
        || !word(tokens[position++], "on")) return invalidIndex(object);
    const only = word(tokens[position], "only");
    if (only) position++;
    if (symbol(tokens[position + 1], ".")) {
        if (!identifier(tokens[position++], object.identity.schema)) return invalidIndex(object);
        position++;
    }
    if (!identifier(tokens[position++], object.identity.parentName)) return invalidIndex(object);
    const suffix = checked.value.text.slice(tokens[position - 1].end);
    if (!word(tokens[position], "using") && !symbol(tokens[position], "(")) return invalidIndex(object);
    return {ok: true, value: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quotePgIdentifier(object.identity.name)} ON ${only ? "ONLY " : ""}${qualified(object.identity.schema, object.identity.parentName)}${suffix}`};
}

function invalidIndex(object: Extract<PgObjectInfo, {kind: "index"}>): ValidationResult<never> {
    return fail("migration.unsupportedSchemaFeature", {index: object.identity.name, reason: "CREATE INDEX must match its recorded name and qualified parent table"});
}

export function generateCreate(schema: PgSchemaInfo): ValidationResult<CreateSqlPlan> {
    if (schema.formatVersion !== 1 || schema.engineVersion !== POSTGRES_SUPPORT.version) {
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
        if (object.kind === "table" && (object.persistence !== "permanent" || object.relationKind !== "r")) return fail("migration.unsupportedSchemaFeature", {table: object.identity.name, reason: "This table kind requires explicit SQL"});
        if (object.kind === "view" || object.kind === "routine") {
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
    const indexes = schema.objects
        .filter((one): one is Extract<PgObjectInfo, {kind: "index"}> => one.kind === "index")
        .sort((a, b) => compareCreateIdentity(a.identity, b.identity));

    const statements: CreateSqlStatement[] = [];
    for (const table of tables) {
        const columns = columnsOf(schema.objects, table.identity);
        if (columns.length === 0) {
            return fail("migration.unsupportedSchemaFeature", {table: table.identity.name, reason: "table has no columns"});
        }
        const definitions: string[] = [];
        for (const column of columns) {
            const definition = columnDefinitionSql(column);
            if (!definition.ok) return definition;
            definitions.push(quotePgIdentifier(column.identity.name) + " " + definition.value);
        }
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
    for (const index of indexes) {
        if (index.ownerConstraint !== null) {
            const owner = constraints.find(one => pgIdentityKey(one.identity) === pgIdentityKey(index.ownerConstraint!));
            if (!index.valid || !index.ready || owner === undefined || !["primaryKey", "unique"].includes(owner.constraintKind)) {
                return fail("migration.unsupportedSchemaFeature", {index: index.identity.name, reason: "Backing index requires its recorded key constraint"});
            }
            continue;
        }
        if (!tables.some(table => table.identity.schema === index.identity.schema && table.identity.name === index.identity.parentName)) {
            return fail("migration.unsupportedSchemaFeature", {index: index.identity.name, reason: "Index parent table is missing"});
        }
        const sql = indexSql(index);
        if (!sql.ok) return sql;
        statements.push({phase: "index", text: sql.value, values: []});
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

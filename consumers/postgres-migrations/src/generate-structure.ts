import {problem, type ValidationResult} from "system-definition";
import type {FieldRefInfo, StructureChangeInfo} from "./authoring-contract";
import {columnDefinitionSql, constraintSql, indexSql, renderPgType} from "./generate-create";
import {samePgIdentity} from "./pg-identity";
import {quotePgIdentifier as quote, quotePgQualified as qualified} from "./pg-sql";
import type {PgObjectInfo, PgSchemaInfo} from "./pg-schema";

export type StructureSql = {change: StructureChangeInfo; text: string; order: number};

/** Emit only a named, inferred effect. PostgreSQL checks dependencies without CASCADE. */
export function generateStructureSql(
    changes: readonly StructureChangeInfo[], from: PgSchemaInfo, to: PgSchemaInfo,
    dataDestinations: readonly FieldRefInfo[] = [],
): ValidationResult<readonly StructureSql[]> {
    const statements: StructureSql[] = [];
    for (const change of changes) {
        const before = from.objects.find(object => change.before !== null && samePgIdentity(object.identity, change.before));
        const after = to.objects.find(object => change.after !== null && samePgIdentity(object.identity, change.after));
        const object = after ?? before;
        if (object === undefined) return invalid(change, "Change has no schema object");
        if (object.kind === "index" && object.ownerConstraint !== null) {
            // PostgreSQL creates/drops the backing index with its constraint; replay still
            // compares the index itself against the independently created desired schema.
            if (!changes.some(one => [one.before, one.after].some(identity => identity !== null && samePgIdentity(identity, object.ownerConstraint!)))) {
                return invalid(change, "An owned index change requires its owning constraint change");
            }
            continue;
        }
        const identity = object.identity;
        const name = qualified(identity.schema, identity.name);
        const parent = qualified(identity.schema, identity.parentName ?? identity.name);
        const receivesData = dataDestinations.some(field => field.side === "to" && field.entity === identity.parentName && field.field === identity.name);
        let text: string | undefined;
        let order = 30;
        if (change.action === "rename" && before !== undefined && after !== undefined) {
            if (before.identity.schema !== after.identity.schema) return invalid(change, "Moving an object between schemas requires explicit SQL");
            if (before.kind === "table" && after.kind === "table") {
                if (change.differences.length > 0) return invalid(change, "Table attribute changes require explicit SQL");
                text = `ALTER TABLE ${qualified(identity.schema, before.identity.name)} RENAME TO ${quote(identity.name)}`;
                order = 5;
            } else if (before.kind === "column" && after.kind === "column") {
                if (before.identity.parentName !== after.identity.parentName && !changes.some(one => one.action === "rename" && one.before?.kind === "table"
                    && one.before.schema === identity.schema && one.before.name === before.identity.parentName && one.after?.name === after.identity.parentName)) return invalid(change, "Moving a column between tables requires explicit SQL");
                text = `ALTER TABLE ${parent} RENAME COLUMN ${quote(before.identity.name)} TO ${quote(identity.name)}`;
                order = 10;
                const altered = columnAlterations(change, before, after, receivesData);
                if (!altered.ok) return altered;
                statements.push(...altered.value);
            }
        } else if (change.action === "add") {
            if (object.kind === "table" && object.persistence === "permanent" && object.relationKind === "r") {
                text = `CREATE TABLE ${name} ()`;
                order = 10;
            } else if (object.kind === "column") {
                const staged = !object.nullable && receivesData;
                const definition = columnDefinitionSql(staged ? {...object, nullable: true} : object);
                if (!definition.ok) return definition;
                text = `ALTER TABLE ${parent} ADD COLUMN ${quote(identity.name)} ${definition.value}`;
                if (staged) statements.push({change, text: `ALTER TABLE ${parent} ALTER COLUMN ${quote(identity.name)} SET NOT NULL;\n`, order: 85});
                order = 20;
            } else if (object.kind === "constraint") {
                const generated = constraintSql(object);
                if (!generated.ok) return generated;
                text = generated.value;
                order = object.constraintKind === "foreignKey" ? 80 : 70;
            } else if (object.kind === "index") {
                const generated = indexSql(object);
                if (!generated.ok) return generated;
                text = generated.value;
                order = 75;
            }
        } else if (change.action === "remove") {
            if (object.kind === "column") {
                const renamed = changes.find(one => one.action === "rename" && one.before?.kind === "table" && one.before.schema === identity.schema
                    && one.before.name === identity.parentName && one.after?.kind === "table");
                const table = renamed?.after ? qualified(renamed.after.schema, renamed.after.name) : parent;
                text = `ALTER TABLE ${table} DROP COLUMN ${quote(identity.name)}`; order = 50;
            }
            if (object.kind === "table") { text = `DROP TABLE ${name}`; order = 60; }
            if (object.kind === "constraint") { text = `ALTER TABLE ${parent} DROP CONSTRAINT ${quote(identity.name)}`; order = 0; }
            if (object.kind === "index" && object.ownerConstraint === null) { text = `DROP INDEX ${name}`; order = 0; }
            if (object.kind === "view") { text = `DROP VIEW ${name}`; order = 0; }
        } else if (change.action === "alter" && before?.kind === "index" && after?.kind === "index") {
            const generated = indexSql(after);
            if (!generated.ok) return generated;
            statements.push({change, text: `DROP INDEX ${qualified(before.identity.schema, before.identity.name)};\n`, order: 0});
            text = generated.value;
            order = 75;
        } else if (change.action === "alter" && before?.kind === "constraint" && after?.kind === "constraint") {
            const generated = constraintSql(after);
            if (!generated.ok) return generated;
            statements.push({change, text: `ALTER TABLE ${qualified(before.identity.schema, before.identity.parentName!)} DROP CONSTRAINT ${quote(before.identity.name)};\n`, order: 0});
            text = generated.value;
            order = after.constraintKind === "foreignKey" ? 80 : 70;
        } else if (change.action === "alter" && before?.kind === "column" && after?.kind === "column") {
            const altered = columnAlterations(change, before, after, receivesData);
            if (!altered.ok) return altered;
            if (altered.value.length === 0) return invalid(change, "Column change has no supported effect");
            statements.push(...altered.value);
            continue;
        }
        if (text === undefined) return invalid(change, "This effect requires a declared manual SQL resource");
        statements.push({change, text: text + ";\n", order});
    }
    return {ok: true, value: statements.sort((a, b) => a.order - b.order || (a.change.id < b.change.id ? -1 : 1))};
}

function columnAlterations(change: StructureChangeInfo, before: Extract<PgObjectInfo, {kind: "column"}>, after: Extract<PgObjectInfo, {kind: "column"}>, receivesData: boolean): ValidationResult<readonly StructureSql[]> {
    if (change.differences.some(diff => !["type", "defaultExpression", "nullable"].includes(diff.path[0] ?? ""))) return invalid(change, "These column attributes require explicit SQL");
    const statements: StructureSql[] = [];
    const prefix = `ALTER TABLE ${qualified(after.identity.schema, after.identity.parentName!)} ALTER COLUMN ${quote(after.identity.name)} `;
    const add = (sql: string, order = 30) => statements.push({change, text: prefix + sql + ";\n", order});
    if (change.differences.some(diff => diff.path[0] === "type")) add(`TYPE ${renderPgType(after.type)}`);
    if (before.defaultExpression !== after.defaultExpression) add(after.defaultExpression === null ? "DROP DEFAULT" : `SET DEFAULT ${after.defaultExpression}`);
    if (before.nullable !== after.nullable) add(after.nullable ? "DROP NOT NULL" : "SET NOT NULL",
        !after.nullable && receivesData ? 85 : 30);
    return {ok: true, value: statements};
}

function invalid(change: StructureChangeInfo, reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.unsupportedSchemaFeature", "blocking", {changeId: change.id, reason})]};
}

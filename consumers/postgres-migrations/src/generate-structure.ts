import {problem, type ValidationResult} from "system-definition";
import type {StructureChangeInfo} from "./authoring-contract";
import {constraintSql, renderPgType} from "./generate-create";
import {samePgIdentity} from "./pg-identity";
import {quotePgIdentifier as quote, quotePgQualified as qualified} from "./pg-sql";
import type {PgObjectInfo, PgSchemaInfo} from "./pg-schema";

export type StructureSql = {change: StructureChangeInfo; text: string; order: number};

/** Emit only a named, inferred effect. PostgreSQL checks dependencies without CASCADE. */
export function generateStructureSql(
    changes: readonly StructureChangeInfo[], from: PgSchemaInfo, to: PgSchemaInfo,
    dataDestinations: ReadonlySet<string> = new Set(),
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
        let text: string | undefined;
        let order = 30;
        if (change.action === "rename" && before !== undefined && after !== undefined) {
            if (before.kind === "table" && after.kind === "table" && before.identity.schema === identity.schema) {
                text = `ALTER TABLE ${qualified(identity.schema, before.identity.name)} RENAME TO ${quote(identity.name)}`;
                order = 0;
            } else if (before.kind === "column" && after.kind === "column") {
                text = `ALTER TABLE ${parent} RENAME COLUMN ${quote(before.identity.name)} TO ${quote(identity.name)}`;
                order = 10;
            }
        } else if (change.action === "add") {
            if (object.kind === "table" && object.persistence === "permanent" && object.relationKind === "r") {
                text = `CREATE TABLE ${name} ()`;
                order = 10;
            } else if (object.kind === "column" && object.identityDefinition === null && object.generatedDefinition === null) {
                const staged = !object.nullable && dataDestinations.has(JSON.stringify([identity.parentName, identity.name]));
                text = `ALTER TABLE ${parent} ADD COLUMN ${quote(identity.name)} ${columnDefinition(staged ? {...object, nullable: true} : object)}`;
                if (staged) statements.push({change, text: `ALTER TABLE ${parent} ALTER COLUMN ${quote(identity.name)} SET NOT NULL;\n`, order: 85});
                order = 20;
            } else if (object.kind === "constraint") {
                const generated = constraintSql(object);
                if (!generated.ok) return generated;
                text = generated.value;
                order = object.constraintKind === "foreignKey" ? 80 : 70;
            }
        } else if (change.action === "remove") {
            if (object.kind === "column") { text = `ALTER TABLE ${parent} DROP COLUMN ${quote(identity.name)}`; order = 50; }
            if (object.kind === "table") { text = `DROP TABLE ${name}`; order = 60; }
            if (object.kind === "constraint") { text = `ALTER TABLE ${parent} DROP CONSTRAINT ${quote(identity.name)}`; order = 0; }
            if (object.kind === "index" && object.ownerConstraint === null) { text = `DROP INDEX ${name}`; order = 0; }
            if (object.kind === "view") { text = `DROP VIEW ${name}`; order = 0; }
        } else if (change.action === "alter" && before?.kind === "constraint" && after?.kind === "constraint") {
            const generated = constraintSql(after);
            if (!generated.ok) return generated;
            text = `ALTER TABLE ${parent} DROP CONSTRAINT ${quote(identity.name)};\n${generated.value}`;
            order = after.constraintKind === "foreignKey" ? 80 : 70;
        } else if (change.action === "alter" && before?.kind === "column" && after?.kind === "column") {
            const alterations: string[] = [];
            const prefix = `ALTER TABLE ${parent} ALTER COLUMN ${quote(identity.name)} `;
            if (change.differences.some(difference => difference.path[0] === "type")) {
                alterations.push(prefix + `TYPE ${renderPgType(after.type)}`);
            }
            if (before.defaultExpression !== after.defaultExpression) {
                alterations.push(prefix + (after.defaultExpression === null ? "DROP DEFAULT" : `SET DEFAULT ${after.defaultExpression}`));
            }
            if (before.nullable !== after.nullable) alterations.push(prefix + (after.nullable ? "DROP NOT NULL" : "SET NOT NULL"));
            if (alterations.length > 0) text = alterations.join(";\n");
            if (!after.nullable && dataDestinations.has(JSON.stringify([identity.parentName, identity.name]))) order = 85;
        }
        if (text === undefined) return invalid(change, "This effect requires a declared manual SQL resource");
        statements.push({change, text: text + ";\n", order});
    }
    return {ok: true, value: statements.sort((a, b) => a.order - b.order || (a.change.id < b.change.id ? -1 : 1))};
}

function columnDefinition(column: Extract<PgObjectInfo, {kind: "column"}>): string {
    return renderPgType(column.type)
        + (column.defaultExpression === null ? "" : ` DEFAULT ${column.defaultExpression}`)
        + (column.nullable ? "" : " NOT NULL");
}

function invalid(change: StructureChangeInfo, reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.unsupportedSchemaFeature", "blocking", {changeId: change.id, reason})]};
}

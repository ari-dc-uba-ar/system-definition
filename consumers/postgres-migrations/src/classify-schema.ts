import {isPlainObject} from "system-definition";
import type {ChangeImpact} from "./authoring-contract";
import type {SchemaComparisonInfo, SchemaDifferenceInfo} from "./compare-schema";

export type SchemaClassificationInfo = {
    equal: SchemaComparisonInfo["equal"];
    differences: readonly (SchemaDifferenceInfo & {impact: ChangeImpact})[];
};

/** Classifies schema evidence only; row validity and user intent need later decisions. */
export function classifySchemaDifference(difference: SchemaDifferenceInfo): ChangeImpact {
    const {path, change, before, after} = difference;
    if (path[0] === "schemas") {
        return Array.isArray(before) && Array.isArray(after) && before.every(schema => after.includes(schema))
            ? "preserving" : "unsupported";
    }
    if (path[0] !== "objects") return "unsupported";
    const kind = path[2];
    const object = change === "add" ? after : before;
    if (change !== "change" && isPlainObject(object) && isPlainObject(object.identity)) {
        if (change === "remove") {
            if (kind === "table" || kind === "column") return "destructive";
            return kind === "constraint" || kind === "index" || kind === "view" ? "preserving" : "unsupported";
        }
        if (kind === "column") return object.nullable === true ? "preserving" : "requiresDataCheck";
        if (kind === "constraint" || kind === "index") return "requiresDataCheck";
        return kind === "table" || kind === "view" || kind === "routine" ? "preserving" : "unsupported";
    }
    if (kind === "column") {
        const attribute = path[5];
        if (attribute === "type") return "requiresDataCheck";
        if (attribute === "nullable") return before === true && after === false ? "requiresDataCheck" : "preserving";
        if (attribute === "defaultExpression") return "preserving";
        return "unsupported";
    }
    if (kind === "constraint") return "requiresDataCheck";
    return kind === "view" || kind === "routine" ? "preserving" : "unsupported";
}

export function classifySchemaDifferences(comparison: SchemaComparisonInfo): SchemaClassificationInfo {
    const tables = comparison.differences.filter(diff => diff.path[2] === "table" && diff.path.length === 4);
    const belongsTo = (diff: SchemaDifferenceInfo, change: "add" | "remove") => tables.some(table =>
        table.change === change && table.path[1] === diff.path[1] && table.path[3] === diff.path[3]);
    const child = (diff: SchemaDifferenceInfo) => ["column", "constraint", "index"].includes(diff.path[2] ?? "");
    return {equal: comparison.equal, differences: comparison.differences
        // Dropping a table is one data decision, including all its children.
        .filter(diff => !(diff.change === "remove" && child(diff) && belongsTo(diff, "remove")))
        .map(diff => ({...diff, impact: diff.change === "add" && child(diff) && belongsTo(diff, "add")
            // A newly created table has no existing rows to backfill or validate.
            ? "preserving" : classifySchemaDifference(diff)}))};
}

import {
    problem,
    type ValidationResult,
} from "system-definition";
import type {ManagedDataInfo} from "./artifact";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function safeName(value: string): boolean {
    return value.length > 0 && !value.includes("\0");
}

function rowKey(row: Readonly<Record<string, string | null>>, key: readonly string[]): string {
    return JSON.stringify(key.map(column => row[column] ?? null));
}

function validateDeclaration(managed: ManagedDataInfo): ValidationResult<true> {
    if (!safeName(managed.table.schema) || !safeName(managed.table.name)) {
        return fail("migration.unsupportedFormat", {reason: "managed data table identity is invalid"});
    }
    if (managed.key.length === 0 || managed.columns.length === 0
        || managed.key.some(column => !safeName(column)) || managed.columns.some(column => !safeName(column))) {
        return fail("migration.unsupportedFormat", {reason: "managed data requires non-empty safe key/column names"});
    }
    if (new Set(managed.key).size !== managed.key.length || new Set(managed.columns).size !== managed.columns.length) {
        return fail("migration.unsupportedFormat", {reason: "managed data key/columns must not repeat"});
    }
    const columns = new Set(managed.columns);
    const missingKey = managed.key.find(column => !columns.has(column));
    if (missingKey !== undefined) {
        return fail("migration.invalidReference", {column: missingKey, reason: "managed data columns must include every key column"});
    }

    const seen = new Set<string>();
    for (const row of managed.rows) {
        const rowColumns = Object.keys(row).sort();
        const declared = [...managed.columns].sort();
        if (rowColumns.length !== declared.length || rowColumns.some((column, index) => column !== declared[index])) {
            return fail("migration.unsupportedFormat", {reason: "managed data row keys must equal declared columns"});
        }
        for (const column of managed.columns) {
            const value = row[column];
            if (value !== null && typeof value !== "string") {
                return fail("migration.unsupportedFormat", {column, reason: "managed data values must be string or null"});
            }
        }
        const key = rowKey(row, managed.key);
        if (seen.has(key)) {
            return fail("migration.invalidReference", {reason: "managed data key is duplicated"});
        }
        seen.add(key);
    }
    return {ok: true, value: true};
}

function selectFor(managed: ManagedDataInfo): {text: string; values: readonly SqlParameter[]} {
    const columns = managed.columns.map(quotePgIdentifier).join(", ");
    const table = quotePgIdentifier(managed.table.schema) + "." + quotePgIdentifier(managed.table.name);
    const values: SqlParameter[] = [];
    const predicates = managed.rows.map(row => {
        const terms = managed.key.map(column => {
            values.push(row[column] ?? null);
            return quotePgIdentifier(column) + " IS NOT DISTINCT FROM $" + values.length;
        });
        return "(" + terms.join(" AND ") + ")";
    });
    // No rows means there is nothing managed to compare, and no DB read is necessary.
    const where = predicates.length === 0 ? "FALSE" : predicates.join(" OR ");
    return {
        text: "SELECT " + columns + " FROM " + table + " WHERE " + where,
        values,
    };
}

function decodeActualRows(
    rows: readonly Readonly<Record<string, unknown>>[],
    managed: ManagedDataInfo,
): ValidationResult<readonly Readonly<Record<string, string | null>>[]> {
    const result: Readonly<Record<string, string | null>>[] = [];
    for (const row of rows) {
        const decoded: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
        for (const column of managed.columns) {
            const value = row[column];
            if (value !== null && typeof value !== "string") {
                return fail("migration.unsupportedFormat", {column, reason: "managed data query returned a non-machine-string value"});
            }
            decoded[column] = value;
        }
        result.push(decoded);
    }
    return {ok: true, value: result};
}

function sameManagedRows(
    expected: ManagedDataInfo,
    actual: readonly Readonly<Record<string, string | null>>[],
): boolean {
    if (actual.length !== expected.rows.length) return false;
    const actualByKey = new Map<string, Readonly<Record<string, string | null>>>();
    for (const row of actual) {
        const key = rowKey(row, expected.key);
        if (actualByKey.has(key)) return false;
        actualByKey.set(key, row);
    }
    for (const row of expected.rows) {
        const actualRow = actualByKey.get(rowKey(row, expected.key));
        if (actualRow === undefined) return false;
        for (const column of expected.columns) {
            if (actualRow[column] !== row[column]) return false;
        }
    }
    return true;
}

export async function checkManagedData(
    session: PgSession,
    managed: readonly ManagedDataInfo[],
): Promise<ValidationResult<true>> {
    const declarations = new Set<string>();
    for (const declaration of managed) {
        const valid = validateDeclaration(declaration);
        if (!valid.ok) return valid;
        const declarationKey = JSON.stringify([declaration.table.schema, declaration.table.name, [...declaration.key]]);
        if (declarations.has(declarationKey)) {
            return fail("migration.invalidReference", {reason: "managed data declaration is duplicated"});
        }
        declarations.add(declarationKey);

        if (declaration.rows.length === 0) continue;
        const query = selectFor(declaration);
        let queried: Awaited<ReturnType<PgSession["query"]>>;
        try {
            queried = await session.query(query.text, query.values);
        } catch (error) {
            return fail("migration.inspectionFailed", {
                reason: error instanceof Error ? error.message : String(error),
                table: declaration.table.schema + "." + declaration.table.name,
            });
        }
        const actual = decodeActualRows(queried.rows, declaration);
        if (!actual.ok) return actual;
        if (!sameManagedRows(declaration, actual.value)) {
            return fail("migration.invalidReference", {
                table: declaration.table.schema + "." + declaration.table.name,
                reason: "managed data differs from the declared rows/columns",
            });
        }
    }
    return {ok: true, value: true};
}

import {
    problem,
    canonicalJson,
    toJsonValue,
    type JsonValue,
    type ValidationResult,
} from "system-definition";
import type {PgObjectInfo, PgSchemaInfo} from "./pg-schema";
import {pgIdentityKey, pgIdentityPath} from "./pg-identity";
import type {InspectionInfo} from "./inspect-schema";
import {POSTGRES_SUPPORT} from "./postgres-support";

export type SchemaDifferenceInfo = {
    path: readonly string[];
    change: "add" | "remove" | "change";
    before: JsonValue | null;
    after: JsonValue | null;
};

export type SchemaComparisonInfo = {
    equal: boolean;
    differences: readonly SchemaDifferenceInfo[];
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function jsonValue(value: unknown): JsonValue {
    const converted = toJsonValue(value);
    if (!converted.ok) throw new TypeError("schema comparison value is not strict JSON");
    return converted.value;
}

function plainRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareValue(
    expected: JsonValue,
    actual: JsonValue,
    path: readonly string[],
    differences: SchemaDifferenceInfo[],
): void {
    if (Object.is(expected, actual)) return;

    if (plainRecord(expected) && plainRecord(actual)) {
        const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
        for (const key of keys) {
            const hasExpected = Object.prototype.hasOwnProperty.call(expected, key);
            const hasActual = Object.prototype.hasOwnProperty.call(actual, key);
            if (!hasExpected) {
                differences.push({path: [...path, key], change: "add", before: null, after: jsonValue(actual[key]!)});
            } else if (!hasActual) {
                differences.push({path: [...path, key], change: "remove", before: jsonValue(expected[key]!), after: null});
            } else {
                compareValue(expected[key]!, actual[key]!, [...path, key], differences);
            }
        }
        return;
    }

    // Arrays carry semantic ordering for keys, FK pairs/signatures, etc.; report them as one value.
    if (Array.isArray(expected) && Array.isArray(actual) && canonicalJson(expected) === canonicalJson(actual)) return;
    differences.push({path, change: "change", before: jsonValue(expected), after: jsonValue(actual)});
}

export function compareSchemaValues(before: JsonValue, after: JsonValue): readonly SchemaDifferenceInfo[] {
    const differences: SchemaDifferenceInfo[] = [];
    compareValue(before, after, [], differences);
    return differences;
}

export function schemaObjectMap(schema: PgSchemaInfo): ValidationResult<Map<string, PgObjectInfo>> {
    if (schema.formatVersion !== 1 || schema.engineVersion !== POSTGRES_SUPPORT.version) {
        return fail("migration.unsupportedFormat", {reason: "schema format or PostgreSQL engine version mismatch"});
    }
    const result = new Map<string, PgObjectInfo>();
    for (const object of schema.objects) {
        if (object.identity.kind !== object.kind) {
            return fail("migration.unsupportedSchemaFeature", {
                object: pgIdentityKey(object.identity),
                reason: "object identity kind does not match its descriptor kind",
            });
        }
        const key = pgIdentityKey(object.identity);
        if (result.has(key)) {
            return fail("migration.unsupportedSchemaFeature", {object: key, reason: "duplicate schema object identity"});
        }
        result.set(key, object);
    }
    return {ok: true, value: result};
}

export function compareSchemas(
    expected: PgSchemaInfo,
    actual: InspectionInfo,
): ValidationResult<SchemaComparisonInfo> {
    if (actual.unknown.length > 0) {
        const first = actual.unknown[0];
        return fail("migration.unsupportedSchemaFeature", {
            feature: first?.feature ?? "unknown",
            object: first === undefined ? "unknown" : pgIdentityKey(first.object),
        });
    }

    const expectedSchemas = [...expected.schemas].sort();
    const actualSchemas = [...actual.schema.schemas].sort();
    const differences: SchemaDifferenceInfo[] = [];
    compareValue(expectedSchemas, actualSchemas, ["schemas"], differences);

    const expectedMap = schemaObjectMap(expected);
    if (!expectedMap.ok) return expectedMap;
    const actualMap = schemaObjectMap(actual.schema);
    if (!actualMap.ok) return actualMap;

    const keys = [...new Set([...expectedMap.value.keys(), ...actualMap.value.keys()])].sort();
    for (const key of keys) {
        const before = expectedMap.value.get(key);
        const after = actualMap.value.get(key);
        if (before === undefined && after !== undefined) {
            differences.push({
                path: pgIdentityPath(after.identity),
                change: "add",
                before: null,
                after: jsonValue(after),
            });
        } else if (before !== undefined && after === undefined) {
            differences.push({
                path: pgIdentityPath(before.identity),
                change: "remove",
                before: jsonValue(before),
                after: null,
            });
        } else if (before !== undefined && after !== undefined) {
            compareValue(before, after, pgIdentityPath(before.identity), differences);
        }
    }

    return {ok: true, value: {equal: differences.length === 0, differences}};
}

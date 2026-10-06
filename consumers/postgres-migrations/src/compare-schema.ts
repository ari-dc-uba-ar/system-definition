import {
    problem,
    toJsonValue,
    type JsonValue,
    type ValidationResult,
} from "system-definition";
import type {PgObjectInfo, PgSchemaInfo} from "./pg-schema";
import {pgIdentityKey, type PgObjectIdentity} from "./pg-identity";
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

function identityParts(identity: PgObjectIdentity): readonly string[] {
    const parts = ["objects", identity.schema, identity.kind];
    if (identity.parentName !== null) parts.push(identity.parentName);
    parts.push(identity.name);
    if (identity.signature.length > 0) parts.push(...identity.signature);
    return parts;
}

function jsonValue(value: unknown): JsonValue {
    const converted = toJsonValue(value);
    if (!converted.ok) throw new TypeError("schema comparison value is not strict JSON");
    return converted.value;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((one, index) => sameJson(one, right[index]));
    }
    if (plainRecord(left) && plainRecord(right)) {
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return leftKeys.length === rightKeys.length
            && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
    }
    return false;
}

function compareValue(
    expected: unknown,
    actual: unknown,
    path: readonly string[],
    differences: SchemaDifferenceInfo[],
): void {
    if (sameJson(expected, actual)) return;

    if (plainRecord(expected) && plainRecord(actual)) {
        const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
        for (const key of keys) {
            const hasExpected = Object.prototype.hasOwnProperty.call(expected, key);
            const hasActual = Object.prototype.hasOwnProperty.call(actual, key);
            if (!hasExpected) {
                differences.push({path: [...path, key], change: "add", before: null, after: jsonValue(actual[key])});
            } else if (!hasActual) {
                differences.push({path: [...path, key], change: "remove", before: jsonValue(expected[key]), after: null});
            } else {
                compareValue(expected[key], actual[key], [...path, key], differences);
            }
        }
        return;
    }

    // Arrays carry semantic ordering for keys, FK pairs/signatures, etc.; report them as one value.
    differences.push({path, change: "change", before: jsonValue(expected), after: jsonValue(actual)});
}

function normalizeObject(object: PgObjectInfo): PgObjectInfo {
    // The inspector already strips OIDs.  A strict JSON round trip detaches data and gives us
    // deterministic enumerable shapes without altering array order inside semantic fields.
    return jsonValue(object) as unknown as PgObjectInfo;
}

function objectMap(objects: readonly PgObjectInfo[]): ValidationResult<Map<string, PgObjectInfo>> {
    const result = new Map<string, PgObjectInfo>();
    for (const object of objects) {
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
        result.set(key, normalizeObject(object));
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
    if (expected.formatVersion !== 1 || actual.schema.formatVersion !== 1
        || expected.engineVersion !== POSTGRES_SUPPORT.version || actual.schema.engineVersion !== POSTGRES_SUPPORT.version) {
        return fail("migration.unsupportedFormat", {reason: "schema format or PostgreSQL engine version mismatch"});
    }

    const expectedSchemas = [...expected.schemas].sort();
    const actualSchemas = [...actual.schema.schemas].sort();
    const differences: SchemaDifferenceInfo[] = [];
    compareValue(expectedSchemas, actualSchemas, ["schemas"], differences);

    const expectedMap = objectMap(expected.objects);
    if (!expectedMap.ok) return expectedMap;
    const actualMap = objectMap(actual.schema.objects);
    if (!actualMap.ok) return actualMap;

    const keys = [...new Set([...expectedMap.value.keys(), ...actualMap.value.keys()])].sort();
    for (const key of keys) {
        const before = expectedMap.value.get(key);
        const after = actualMap.value.get(key);
        if (before === undefined && after !== undefined) {
            differences.push({
                path: identityParts(after.identity),
                change: "add",
                before: null,
                after: jsonValue(after),
            });
        } else if (before !== undefined && after === undefined) {
            differences.push({
                path: identityParts(before.identity),
                change: "remove",
                before: jsonValue(before),
                after: null,
            });
        } else if (before !== undefined && after !== undefined) {
            compareValue(before, after, identityParts(before.identity), differences);
        }
    }

    return {ok: true, value: {equal: differences.length === 0, differences}};
}

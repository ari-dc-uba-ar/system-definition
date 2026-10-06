import {ValidationResult, problem} from "./problem";
import {childPath, isPlainObject} from "./decode-structure";

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | {readonly [key: string]: JsonValue};

type InvalidJson = {
    path: string
    reason: string
};

type CopyResult =
    | {ok: true, value: JsonValue}
    | {ok: false, error: InvalidJson};

function invalid(path: string, reason: string): CopyResult {
    return {ok: false, error: {path, reason}};
}

function arrayPath(path: string, index: number): string {
    return path + "[" + index + "]";
}

function copyJsonValue(value: unknown, ancestors: Set<object>, path: string): CopyResult {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return {ok: true, value};
    }
    if (typeof value === "number") {
        return Number.isFinite(value)
            ? {ok: true, value}
            : invalid(path, "number must be finite");
    }
    if (typeof value !== "object") {
        return invalid(path, "value is not representable as JSON");
    }

    if (ancestors.has(value)) {
        return invalid(path, "cyclic reference");
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) {
                return invalid(path, "array subclasses are not plain JSON arrays");
            }
            return copyArray(value, ancestors, path);
        }
        if (!isPlainObject(value)) {
            return invalid(path, "object must be plain");
        }
        return copyObject(value, ancestors, path);
    } catch {
        return invalid(path, "value could not be inspected safely");
    } finally {
        ancestors.delete(value);
    }
}

function copyArray(value: unknown[], ancestors: Set<object>, path: string): CopyResult {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    for (const key of ownKeys) {
        if (typeof key === "symbol") {
            return invalid(path, "symbol-keyed array properties are not representable as JSON");
        }
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= 0xffff_ffff || String(index) !== key) {
            return invalid(childPath(path, key), "extra array property would be lost by JSON serialization");
        }
    }

    if (ownKeys.length - 1 !== value.length) {
        const indices = ownKeys
            .filter((key): key is string => typeof key === "string" && key !== "length")
            .map(Number)
            .sort((left, right) => left - right);
        let expected = 0;
        for (const index of indices) {
            if (index !== expected) break;
            expected++;
        }
        return invalid(arrayPath(path, expected), "array hole is not valid JSON data");
    }

    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) {
            return invalid(arrayPath(path, index), "array hole is not valid JSON data");
        }
        if (!("value" in descriptor)) {
            return invalid(arrayPath(path, index), "array accessors are not valid JSON data");
        }
        const copied = copyJsonValue(descriptor.value, ancestors, arrayPath(path, index));
        if (!copied.ok) return copied;
        result.push(copied.value);
    }
    return {ok: true, value: result};
}

function copyObject(value: object, ancestors: Set<object>, path: string): CopyResult {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, JsonValue>;

    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") {
            return invalid(path, "symbol-keyed object properties are not representable as JSON");
        }
        const descriptor = descriptors[key];
        const propertyPath = childPath(path, key);
        if (!("value" in descriptor)) {
            return invalid(propertyPath, "object accessors are not valid JSON data");
        }
        if (!descriptor.enumerable) {
            return invalid(propertyPath, "non-enumerable property would be lost by JSON serialization");
        }
        const copied = copyJsonValue(descriptor.value, ancestors, propertyPath);
        if (!copied.ok) return copied;
        Object.defineProperty(result, key, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: copied.value,
        });
    }
    return {ok: true, value: result};
}

export function toJsonValue(value: unknown): ValidationResult<JsonValue> {
    const copied = copyJsonValue(value, new Set<object>(), "$");
    if (copied.ok) return copied;
    return {
        ok: false,
        problems: [problem(null, "migration.invalidJson", "blocking", copied.error)],
    };
}

function stringifyValidated(value: JsonValue): string {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number" || typeof value === "string") {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new TypeError("invalid JSON value");
        return serialized;
    }
    if (Array.isArray(value)) {
        return "[" + value.map(stringifyValidated).join(",") + "]";
    }

    const objectValue = value as {readonly [key: string]: JsonValue};
    return "{" + Object.keys(objectValue)
        .sort()
        .map(key => JSON.stringify(key) + ":" + stringifyValidated(objectValue[key]))
        .join(",") + "}";
}

export function canonicalJson(value: JsonValue): string {
    const copied = copyJsonValue(value, new Set<object>(), "$");
    if (!copied.ok) {
        throw new TypeError("invalid JSON value at " + copied.error.path + ": " + copied.error.reason);
    }
    return stringifyValidated(copied.value);
}

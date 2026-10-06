import {createHash} from "node:crypto";
import {canonicalJson, type JsonValue} from "system-definition";

/** Hash already-validated strict JSON using the repository's canonical JSON encoding. */
export function canonicalJsonSha256(value: JsonValue): string {
    return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Copy a strict JSON object while omitting domain-selected fields. */
export function omitJsonObjectKeys(
    value: JsonValue,
    omitted: readonly string[],
): Record<string, JsonValue> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("expected a strict JSON object");
    }
    const ignored = new Set(omitted);
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const [key, field] of Object.entries(value)) {
        if (!ignored.has(key)) result[key] = field;
    }
    return result;
}

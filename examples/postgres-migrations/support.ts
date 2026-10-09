/* Small example conveniences; hashing uses the same canonical serialization as artifacts. */
import {createHash} from "node:crypto";
import {canonicalJson, toJsonValue, type ValidationResult} from "system-definition";
export function valueOf<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
export function textHash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
export function contentHash(value: unknown): string { return textHash(canonicalJson(valueOf(toJsonValue(value)))); }

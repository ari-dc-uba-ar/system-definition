import type {ValidationResult} from "./problem";

export type StructuralObject = Readonly<Record<string, unknown>>;

export type StructuralFailure = (path: string, reason: string) => ValidationResult<never>;

/**
 * The repository-wide object-shape boundary. It deliberately rejects arrays and
 * exotic prototypes so every decoder starts from the same meaning of "plain object".
 */
export function isPlainObject(value: unknown): value is StructuralObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Preserve the bracket-path convention already used by migration diagnostics. */
export function childPath(path: string, key: string): string {
    return path + "[" + JSON.stringify(key) + "]";
}

/**
 * Share exact-shape mechanics without taking ownership of boundary semantics.
 * The caller still decides which Problem/message key represents the structural failure.
 */
export function exactOptionalKeys(
    value: StructuralObject,
    required: readonly string[],
    optional: readonly string[],
    path: string,
    invalid: StructuralFailure,
): ValidationResult<true> {
    const allowed = new Set([...required, ...optional]);
    const unexpected = Object.keys(value).find(key => !allowed.has(key));
    if (unexpected !== undefined) {
        return invalid(childPath(path, unexpected), "unexpected property");
    }
    const missing = required.find(key => !Object.prototype.hasOwnProperty.call(value, key));
    if (missing !== undefined) {
        return invalid(childPath(path, missing), "missing property");
    }
    return {ok: true, value: true};
}

export function exactKeys(
    value: StructuralObject,
    expected: readonly string[],
    path: string,
    invalid: StructuralFailure,
): ValidationResult<true> {
    return exactOptionalKeys(value, expected, [], path, invalid);
}

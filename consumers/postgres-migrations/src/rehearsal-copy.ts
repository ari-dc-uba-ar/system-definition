import {
    childPath,
    decodeReleaseRefInfo,
    exactKeys,
    isNonEmptyString,
    isPlainObject,
    sameReleaseRef,
    type ReleaseRefInfo,
    type StructuralFailure,
    type ValidationResult,
} from "system-definition";

export type RehearsalCopyRef = {
    copyId: string;
    provenance: string;
    installationId: string;
    source: ReleaseRefInfo;
    schemas: readonly string[];
};

function decodeSchemas(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<readonly string[]> {
    if (!Array.isArray(value) || value.length === 0) {
        return invalid(path, "rehearsal copy schemas must be a non-empty array");
    }
    const schemas: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const schema = value[index];
        const itemPath = path + "[" + index + "]";
        if (!isNonEmptyString(schema)) return invalid(itemPath, "rehearsal copy schema must not be empty");
        if (seen.has(schema)) return invalid(itemPath, "rehearsal copy schemas must not repeat");
        seen.add(schema);
        schemas.push(schema);
    }
    return {ok: true, value: schemas};
}

/** External unknown-to-copy boundary. */
export function decodeRehearsalCopyRef(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<RehearsalCopyRef> {
    if (!isPlainObject(value)) return invalid(path, "expected a rehearsal copy reference");
    const shape = exactKeys(value, ["copyId", "provenance", "installationId", "source", "schemas"], path, invalid);
    if (!shape.ok) return shape;
    if (!isNonEmptyString(value.copyId)) return invalid(childPath(path, "copyId"), "copyId must not be empty");
    if (!isNonEmptyString(value.provenance)) return invalid(childPath(path, "provenance"), "provenance must not be empty");
    if (!isNonEmptyString(value.installationId)) {
        return invalid(childPath(path, "installationId"), "installationId must not be empty");
    }
    const source = decodeReleaseRefInfo(value.source, childPath(path, "source"), invalid);
    if (!source.ok) return source;
    const schemas = decodeSchemas(value.schemas, childPath(path, "schemas"), invalid);
    if (!schemas.ok) return schemas;
    return {
        ok: true,
        value: {
            copyId: value.copyId,
            provenance: value.provenance,
            installationId: value.installationId,
            source: source.value,
            schemas: schemas.value,
        },
    };
}

/** Intrinsic ordered identity/equality; policy about where a copy may be used stays with callers. */
export function sameRehearsalCopyRef(left: RehearsalCopyRef, right: RehearsalCopyRef): boolean {
    return left.copyId === right.copyId
        && left.provenance === right.provenance
        && left.installationId === right.installationId
        && sameReleaseRef(left.source, right.source)
        && left.schemas.length === right.schemas.length
        && left.schemas.every((schema, index) => schema === right.schemas[index]);
}

/**
 * Typed preflight refinement. Unlike decodeRehearsalCopyRef this does not treat a
 * typed value as a fresh external unknown boundary; it only rechecks the identity
 * properties preparation relies on before executing against an identified copy.
 */
export function hasWellFormedRehearsalCopyIdentity(copy: RehearsalCopyRef): boolean {
    return isNonEmptyString(copy.copyId)
        && isNonEmptyString(copy.provenance)
        && isNonEmptyString(copy.installationId)
        && copy.schemas.length > 0
        && copy.schemas.every(isNonEmptyString)
        && new Set(copy.schemas).size === copy.schemas.length;
}

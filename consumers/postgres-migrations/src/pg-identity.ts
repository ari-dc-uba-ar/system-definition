import {compareUtf16, decodeArray, hasExactKeys, isNonEmptyString, isPlainObject, type StructuralFailure, type ValidationResult} from "system-definition";

export type PgObjectIdentity<K extends string = string> = {
    schema: string;
    kind: K;
    name: string;
    parentName: K extends "column" | "constraint" | "index" ? string : K extends "table" | "view" | "routine" ? null : string | null;
    signature: readonly string[];
};

export function pgIdentityKey(identity: PgObjectIdentity): string {
    return JSON.stringify([
        identity.schema,
        identity.kind,
        identity.parentName,
        identity.name,
        [...identity.signature],
    ]);
}

export function pgIdentityPath(identity: PgObjectIdentity): readonly string[] {
    return ["objects", identity.schema, identity.kind,
        ...(identity.parentName === null ? [] : [identity.parentName]), identity.name, ...identity.signature];
}

export function samePgIdentity(left: PgObjectIdentity, right: PgObjectIdentity): boolean {
    return pgIdentityKey(left) === pgIdentityKey(right);
}

export function comparePgIdentity(left: PgObjectIdentity, right: PgObjectIdentity): number {
    return compareUtf16(pgIdentityKey(left), pgIdentityKey(right));
}

export function decodePgObjectIdentity(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<PgObjectIdentity> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["schema", "kind", "name", "parentName", "signature"])
        || !isNonEmptyString(value.schema) || !isNonEmptyString(value.kind) || !isNonEmptyString(value.name)
        || (value.parentName !== null && !isNonEmptyString(value.parentName))) return invalid(path, "invalid SQL identity");
    const signature = decodeArray(value.signature, path + ".signature", invalid,
        (raw, at) => isNonEmptyString(raw) ? {ok: true, value: raw} : invalid(at, "expected a signature name"));
    return signature.ok ? {ok: true, value: {schema: value.schema, kind: value.kind, name: value.name, parentName: value.parentName, signature: signature.value}} : signature;
}

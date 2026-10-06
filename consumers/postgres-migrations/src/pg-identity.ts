import {compareUtf16} from "system-definition";

export type PgObjectIdentity = {
    schema: string;
    kind: string;
    name: string;
    parentName: string | null;
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

export function samePgIdentity(left: PgObjectIdentity, right: PgObjectIdentity): boolean {
    return pgIdentityKey(left) === pgIdentityKey(right);
}

export function comparePgIdentity(left: PgObjectIdentity, right: PgObjectIdentity): number {
    return compareUtf16(pgIdentityKey(left), pgIdentityKey(right));
}

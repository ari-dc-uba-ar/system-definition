import type {PgObjectIdentity as IdentityOwnerType} from "../src/pg-identity";
import type {PgObjectIdentity as SchemaCompatibilityType} from "../src/pg-schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;
type Assert<T extends true> = T;

type _IdentityTypeHasOneShape = Assert<Equal<IdentityOwnerType, SchemaCompatibilityType>>;

const valid: IdentityOwnerType = {schema: "app", kind: "table", name: "x", parentName: null, signature: []};
void valid;

// @ts-expect-error identity parentName is explicitly nullable, not optional
const missingParent: IdentityOwnerType = {schema: "app", kind: "table", name: "x", signature: []};
void missingParent;

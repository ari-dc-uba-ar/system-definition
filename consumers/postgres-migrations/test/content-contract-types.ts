import type {
    ContentRefInfo,
    FileResourceInfo,
    ResourceInfo,
    ResourceRefInfo,
} from "system-definition";
import type {QueryResourceInfo} from "../src/authoring-contract";
import type {QueryRefInfo} from "../src/migration-authoring";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;
type Expect<T extends true> = T;

type _QueryRefUsesSharedShape = Expect<Equal<QueryRefInfo, ContentRefInfo<"query">>>;
type _QueryResourceUsesSharedShape = Expect<Equal<QueryResourceInfo, FileResourceInfo<"query">>>;
type _MigrationRefUsesSharedShape = Expect<Equal<ResourceRefInfo, ContentRefInfo<"sql" | "check">>>;
type _MigrationResourceUsesSharedShape = Expect<Equal<ResourceInfo, FileResourceInfo<"sql" | "check">>>;

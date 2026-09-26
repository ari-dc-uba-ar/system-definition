import type {ValidationResult} from "../src/common/problem";
import type {MigrationInfo, ReleaseRefInfo} from "../src/common/migration";
import {
    completeMigrationCatalog,
    resolveMigrationPath,
    type MigrationCatalogInfo,
    type MigrationPathInfo,
    type MigrationPlanInfo,
    type PublishedMigrationInfo,
} from "../src/common/migration-plan";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Same<A, B> = IsAssignable<A, B> extends true ? IsAssignable<B, A> : false;

type PublishedMigrationContract = {
    migration: MigrationInfo;
    migrationHash: string;
};

type MigrationCatalogContract = {
    systemId: string;
    releases: readonly ReleaseRefInfo[];
    migrations: readonly PublishedMigrationContract[];
};

type MigrationPathContract = {
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    migrations: readonly PublishedMigrationContract[];
};

type MigrationPlanContract = {
    formatVersion: 1;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    migrations: readonly PublishedMigrationContract[];
    planHash: string;
};

type CompleteCatalogContract = (
    releases: readonly ReleaseRefInfo[],
    migrations: readonly PublishedMigrationContract[],
) => ValidationResult<MigrationCatalogContract>;

type ResolvePathContract = (
    catalog: MigrationCatalogContract,
    fromId: string,
    toId: string,
) => ValidationResult<MigrationPathContract>;

/* During RED the module is intentionally absent, so imported symbols are unresolved.
   Once present, these assertions pin the public serializable shapes and pure API. */
type _publishedShape = Assert<IsAny<PublishedMigrationInfo> extends true ? true : Same<PublishedMigrationInfo, PublishedMigrationContract>>;
type _catalogShape = Assert<IsAny<MigrationCatalogInfo> extends true ? true : Same<MigrationCatalogInfo, MigrationCatalogContract>>;
type _pathShape = Assert<IsAny<MigrationPathInfo> extends true ? true : Same<MigrationPathInfo, MigrationPathContract>>;
type _planShape = Assert<IsAny<MigrationPlanInfo> extends true ? true : Same<MigrationPlanInfo, MigrationPlanContract>>;
type _completeSignature = Assert<IsAny<typeof completeMigrationCatalog> extends true ? true : IsAssignable<typeof completeMigrationCatalog, CompleteCatalogContract>>;
type _resolveSignature = Assert<IsAny<typeof resolveMigrationPath> extends true ? true : IsAssignable<typeof resolveMigrationPath, ResolvePathContract>>;

void completeMigrationCatalog;
void resolveMigrationPath;

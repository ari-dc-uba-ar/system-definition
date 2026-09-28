import type {
    MigrationPathInfo,
    PublishedMigrationInfo,
    ValidationResult,
} from "system-definition";
import type {ManagedDataInfo} from "../src/artifact";
import type {InspectionScope} from "../src/inspect-schema";
import type {InstallationInfo, InstallationScope, JournalConfig, MigrationHistoryInfo} from "../src/journal";
import type {PgSchemaInfo, PgSession, ResolvedSqlResource} from "../src/pg-schema";
import {
    executePreparedSqlResource,
    prepareSqlResource,
    runCheckResource,
    type PreparedSqlResource,
} from "../src/sql-resource";
import {
    executeMigration,
    type MigrationExecutionContext,
    type MigrationExecutionInfo,
    type ReleaseExecutionState,
} from "../src/execute-migration";
import {
    executeMigrationPath,
    type MigrationPathExecutionInfo,
} from "../src/runner";

const schema: PgSchemaInfo = {
    formatVersion: 1,
    engineVersion: "18.6",
    schemas: ["app"],
    objects: [],
};
const inspection: InspectionScope = {schemas: ["app"], excluded: []};
const releaseState: ReleaseExecutionState = {
    expectedSchema: schema,
    inspection,
    managedData: [] as readonly ManagedDataInfo[],
    invariantChecks: [],
};
const journal: JournalConfig = {schema: "sd_journal"};
const scope: InstallationScope = {systemId: "aida", schemas: ["app"]};
const resources: Readonly<Record<string, ResolvedSqlResource>> = {};
const context: MigrationExecutionContext = {
    journal,
    scope,
    resources,
    from: releaseState,
    to: releaseState,
    options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
    now: () => "2026-09-28T12:00:00.000Z",
};

const _prepare: (
    resource: ResolvedSqlResource,
) => ValidationResult<PreparedSqlResource> = prepareSqlResource;

const _executeResource: (
    session: PgSession,
    resource: PreparedSqlResource,
) => Promise<ValidationResult<true>> = executePreparedSqlResource;

const _check: (
    session: PgSession,
    resource: ResolvedSqlResource,
) => Promise<ValidationResult<true>> = runCheckResource;

const _executeMigration: (
    session: PgSession,
    migration: PublishedMigrationInfo,
    context: MigrationExecutionContext,
) => Promise<ValidationResult<MigrationExecutionInfo>> = executeMigration;

const _runPath: (
    session: PgSession,
    path: MigrationPathInfo,
    resolveContext: (
        migration: PublishedMigrationInfo,
    ) => Promise<ValidationResult<MigrationExecutionContext>> | ValidationResult<MigrationExecutionContext>,
) => Promise<ValidationResult<MigrationPathExecutionInfo>> = executeMigrationPath;

const _executionInfo: MigrationExecutionInfo = {
    installation: {} as InstallationInfo,
    history: {} as MigrationHistoryInfo,
};
void context;
void _prepare;
void _executeResource;
void _check;
void _executeMigration;
void _runPath;
void _executionInfo;

import type {PersistenceInfo, SystemSnapshotInfo, ValidationResult} from "system-definition";
import {
    checkPostgres18_6,
    projectSchema,
    quotePgIdentifier,
    type PgSchemaInfo,
    type PgSession,
    type PgTypeRepresentation,
    type StorageContext,
} from "../src/pg-schema";
import {
    generateCreate,
    type CreateSqlPlan,
} from "../src/generate-create";

const _project: (
    snapshot: SystemSnapshotInfo,
    persistence: PersistenceInfo,
    storage: StorageContext,
) => ValidationResult<PgSchemaInfo> = projectSchema;
const _generate: (schema: PgSchemaInfo) => ValidationResult<CreateSqlPlan> = generateCreate;
const _version: (session: PgSession) => Promise<ValidationResult<{serverVersionNum: 180006}>> = checkPostgres18_6;
const _quote: (identifier: string) => string = quotePgIdentifier;

const physicalType: PgTypeRepresentation = {
    schema: "pg_catalog",
    name: "text",
    modifiers: [],
};

const storage: StorageContext = {
    representation: "postgres",
    physicalTypes: {text: physicalType},
    schema: "app",
    environment: {
        engine: "postgresql",
        version: "18.6",
        serverVersionNum: 180006,
        encoding: "UTF8",
        collations: {},
        externalDependencies: {},
    },
    resources: {},
    createResources: [],
    managedData: [],
    invariantChecks: [],
};

void _project;
void _generate;
void _version;
void _quote;
void storage;

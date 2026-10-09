/* Physical representation is a consumer concern; the common SSOT remains database independent. */
import type {PersistenceInfo} from "system-definition";
import type {StorageContext} from "@system-definition/postgres-migrations";
export const studentPersistence: PersistenceInfo = {
    entities: ["students"],
    representations: {postgres: {integer: "integer", text: "text", boolean: "boolean"}},
};
export const studentStorage: StorageContext = {
    representation: "postgres", schema: "app",
    physicalTypes: {
        integer: {schema: "pg_catalog", name: "int4", modifiers: []},
        text: {schema: "pg_catalog", name: "text", modifiers: []},
        boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
    },
    // SQL returns machine strings; historical type behaviours perform the conversion.
    // Text stays text: SQL NULL, "", and the string "null" have different meanings.
    machineCodecs: {
        integer: {readExpression: "migration_value::text", transportType: "text"},
        text: {readExpression: "migration_value", transportType: "text"},
        boolean: {readExpression: "CASE WHEN migration_value IS NULL THEN NULL WHEN migration_value THEN 'true' ELSE 'false' END", transportType: "text"},
    },
    environment: {engine: "postgresql", version: "18.6", serverVersionNum: 180006, encoding: "UTF8", collations: {}, externalDependencies: {}},
    resources: {}, createResources: [], managedData: [], invariantChecks: [],
};

"use strict";
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const {commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes, defineRecord, withRecords,
    defineEntity, defineEntities, captureSystemSnapshot, canonicalJson, toJsonValue} = require("system-definition");
const {createPostgresScratch, connectPostgres} = require("../dist/src/pg-session.js");
const {readInstallation} = require("../dist/src/journal.js");
const {dispatchCommand} = require("../dist/src/cli-main.js");
const {sha256Hex} = require("../dist/src/artifact.js");
const value = result => {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;};

async function main() {
    const config = process.env.MIGRATION_DATABASE_URL ? {connectionString: process.env.MIGRATION_DATABASE_URL}
        : process.env.MIGRATION_PGUSER ? {user: process.env.MIGRATION_PGUSER, password: process.env.MIGRATION_PGPASSWORD} : {};
    const provider = createPostgresScratch(config, ["app"]);
    const handle = value(await provider.create("clean-target"));
    try {
        const targetConfig = {...config, database: handle.id};
        if (targetConfig.connectionString) {const url = new URL(targetConfig.connectionString); url.pathname = "/" + handle.id; targetConfig.connectionString = url.toString();}
        const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
        const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}})});
        const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
        const snapshot = value(captureSystemSnapshot(context, {systemId: "first-install", entities}));
        const ref = {systemId: snapshot.systemId, releaseId: "initial", releaseHash: sha256Hex(new TextEncoder().encode(canonicalJson(value(toJsonValue(snapshot)))))};
        const storage = {representation: "postgres", schema: "app", physicalTypes: {
            text: {schema: "pg_catalog", name: "text", modifiers: []}, integer: {schema: "pg_catalog", name: "int4", modifiers: []}, boolean: {schema: "pg_catalog", name: "bool", modifiers: []}},
            environment: {engine: "postgresql", version: "18.6", serverVersionNum: 180006, encoding: "UTF8", collations: {}, externalDependencies: {}},
            resources: {}, createResources: [], managedData: [], invariantChecks: []};
        const input = {ref, snapshot, storage, persistence: {entities: ["items"], representations: {postgres: {text: "text", integer: "integer", boolean: "boolean"}}}, inspection: {schemas: ["app"], excluded: []}};
        const journal = {schema: "installation_journal"};
        const scope = {systemId: snapshot.systemId, schemas: ["app"]};
        const binding = {operation: "install", from: null, to: ref, deploymentId: randomUUID(), installationId: randomUUID(),
            candidateApplicationHash: ref.releaseHash, planHash: ref.releaseHash, configurationHash: ref.releaseHash,
            engineVersion: "18.6", schemas: ["app"], maintenanceId: "isolated-fixture", production: false};
        const scratch = createPostgresScratch(config, ["app"]);
        const project = {release: {input, scratch}, deployment: {binding, scope, lockWaitTimeoutMs: 5000,
            sessions: {openTarget: () => connectPostgres(targetConfig)},
            runtime: {session: handle.session, journal, maintenance: {isActive: async () => true}, finalChecks: async () => ({ok: true, value: true})},
            path: {from: ref, to: ref, migrations: []}, resolveContext: async () => {throw new Error("Unexpected upgrade");},
            verification: {scratch, checks: async () => ["artifacts", "environment", "data"].map(kind => ({id: kind, kind, status: "passed", reportId: kind, problems: []}))}}};
        value(await dispatchCommand("verify", new Map(), project));
        assert.equal(value(await readInstallation(handle.session, journal, scope)), null);
        value(await dispatchCommand("install", new Map(), project));
        assert.equal(value(await readInstallation(handle.session, journal, scope)).current.releaseHash, ref.releaseHash);
        const attempt = await handle.session.query("SELECT state FROM installation_journal.execution_attempt", []);
        assert.equal(attempt.rows[0].state, "succeeded");
        console.log("Fresh CLI installation and durable successful attempt passed");
    } finally {value(await provider.destroy(handle));}
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});

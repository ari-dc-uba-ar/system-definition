import {strict as assert} from "node:assert";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes, type ValidationResult} from "system-definition";
import {decodeSqlSsot} from "../src/sql-mapping";
import {inferSsotMigration, generateSsotMigration} from "../src/ssot-authoring";
import {migrationDirectory, readStoredCatalog, readCatalogState} from "../src/migration-store";
import {verifyMigrationFiles} from "../src/migration-integrity";
import {dispatchSsotAuthoring} from "../src/ssot-cli";
import type {DatabaseSettings} from "../src/database-settings";

function value<T>(result: ValidationResult<T>): T {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;}
const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const snapshot = value(captureSystemSnapshot(context, {systemId: "ssot-authoring", entities}));
const mapping = {text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean};
const system = value(decodeSqlSsot(snapshot, mapping));
const settings: DatabaseSettings = {database: {database: "unused", schema: "app"}, initialUser: {user: "admin"}, owner: {user: "owner"}, appUser: {user: "app"}};
async function temporary(body: (root: string) => Promise<void>) {const root = await mkdtemp(join(tmpdir(), "sd-ssot-authoring-")); try {await body(root);} finally {await rm(root, {recursive: true, force: true});}}

describe("SSOT migration authoring without a project adapter", () => {
    it("saves bound source/target states and catalog entries without connecting to a database", () => temporary(async root => {
        const draft = join(root, "draft.json");
        const inferred = value(await inferSsotMigration(system, settings, root, "initial", draft));
        assert.equal(inferred.pending.length, 0);
        const published = value(await generateSsotMigration(system, settings, root, draft));
        const verified = value(await verifyMigrationFiles(migrationDirectory(root, published), published));
        assert.ok(verified.authoring.states);
        const catalog = value(await readStoredCatalog(root));
        assert.equal(catalog.migrations.length, 1);
        assert.equal(value(await readCatalogState(root, catalog, 0)).schema.objects.length, 0);
        assert.equal(value(await readCatalogState(root, catalog, 1)).schema.objects.filter(object => object.kind === "table").length, 1);
        const statePath = join(migrationDirectory(root, published), "states/to.json");
        const bytes = await readFile(statePath);
        bytes[0] ^= 1;
        await writeFile(statePath, bytes);
        assert.equal((await verifyMigrationFiles(migrationDirectory(root, published), published)).ok, false);
        assert.equal((await readCatalogState(root, catalog, 1)).ok, false);
    }));
    it("authors standalone data SQL as an ordered migration with an unchanged schema", () => temporary(async root => {
        const draft = join(root, "draft.json");
        value(await inferSsotMigration(system, settings, root, "initial", draft));
        value(await generateSsotMigration(system, settings, root, draft));
        const data = value(await inferSsotMigration(system, settings, root, "data-only", draft));
        assert.equal(data.changes.length, 0);
        const published = value(await generateSsotMigration(system, settings, root, draft, {}, {text: 'UPDATE "app"."items" SET "id" = "id" + 1;',
            contract: {id: "increment", resourceName: "increment.sql", dependsOn: [], implementsChanges: [], reads: [],
                writes: [{schema: "app", kind: "table", name: "items", parentName: null, signature: []}], destroys: [], before: [], after: [], rowChecks: []}}));
        const verified = value(await verifyMigrationFiles(migrationDirectory(root, published), published));
        assert.equal(verified.authoring.migration.steps.length, 1);
        const catalog = value(await readStoredCatalog(root));
        assert.equal(catalog.migrations.length, 2);
        assert.deepEqual(value(await readCatalogState(root, catalog, 1)).schema, value(await readCatalogState(root, catalog, 2)).schema);
    }));
    it("rejects a changed backend before saving SQL and rejects unsafe migration IDs", () => temporary(async root => {
        const draft = join(root, "draft.json");
        value(await inferSsotMigration(system, settings, root, "initial", draft));
        const changed = value(decodeSqlSsot({...snapshot, records: {...snapshot.records, changed: {id: {name: "id", type: "integer", nullable: true}}}}, mapping));
        assert.equal((await generateSsotMigration(changed, settings, root, draft)).ok, false);
        assert.equal(value(await readStoredCatalog(root)).migrations.length, 0);
        assert.equal((await inferSsotMigration(system, settings, root, "../escape", draft)).ok, false);
    }));
    it("dispatches infer/generate directly from the backend exports", () => temporary(async root => {
        const ssotFile = join(root, "system.mjs"), databaseFile = join(root, "database.mjs"), store = join(root, "migrations");
        await writeFile(ssotFile, `export const ssot=${JSON.stringify(snapshot)}; export const sqlMapping=${JSON.stringify(mapping)};`);
        await writeFile(databaseFile, `export const databaseSettings=${JSON.stringify(settings)};`);
        const flags = new Map([["ssot", ssotFile], ["database", databaseFile], ["directory", store], ["id", "initial"]]);
        assert.equal((await dispatchSsotAuthoring("infer", flags)).ok, true);
        assert.equal((await dispatchSsotAuthoring("generate", flags)).ok, true);
    }));
});

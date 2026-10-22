import {strict as assert} from "node:assert";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes, type ValidationResult} from "system-definition";
import {decodeSqlSsot} from "../src/sql-mapping";
import {inferSsotMigration, generateSsotMigration, readMigrationDraft} from "../src/ssot-authoring";
import {computeDraftRevisionHash} from "../src/draft-revision";
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
    it("decodes every nested draft shape before a valid revision can reach assembly", () => temporary(async root => {
        const file = join(root, "draft.json");
        const draft = value(await inferSsotMigration(system, settings, root, "initial", file));
        assert.deepEqual(value(await readMigrationDraft(file)), draft);
        const malformed = [
            {base: {}},
            {renames: [{before: {entity: "items"}, after: {side: "to", entity: "items", field: "id"}}]},
            {changes: [{...draft.changes[0], action: "remove", before: null}]},
            {changes: [{...draft.changes[0], differences: [{path: [1], before: null, after: null}]}]},
            {data: [{id: "broken", source: {}, writes: []}]},
            {decisions: [{changeId: "missing", resolution: {kind: "migrate"}}]},
            {manual: [{id: "broken"}]},
            {pending: [{id: "p", kind: "made-up", subjects: [], messageKey: "p"}]},
        ];
        for (const patch of malformed) {
            const candidate = structuredClone(draft);
            Object.assign(candidate, patch);
            candidate.revisionHash = value(computeDraftRevisionHash(candidate));
            await writeFile(file, JSON.stringify(candidate));
            const decoded = await readMigrationDraft(file);
            assert.equal(decoded.ok, false, JSON.stringify(patch));
            if (!decoded.ok) assert.equal(decoded.problems[0]?.messageKey, "migration.unsupportedFormat");
        }
    }));

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
        const directory = migrationDirectory(root, published);
        assert.deepEqual((await readdir(directory)).sort(), ["0001_initial.sql", "metadata.json"]);
        const script = await readFile(join(directory, "0001_initial.sql"), "utf8");
        assert.ok(script.includes('CREATE ROLE "owner"') && script.includes('CREATE ROLE "app"'));
        assert.ok(script.includes('TO "app"'));
        assert.deepEqual(script.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[^;]+;/g), [
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."items" TO "app";',
        ]);
        assert.ok(!/ALTER DEFAULT PRIVILEGES[^;]+\bGRANT\b/.test(script));
        assert.ok(!/^--/m.test(script));
        assert.ok(verified.authoring.initial);
        const metadataFile = join(directory, "metadata.json"), metadata = JSON.parse(await readFile(metadataFile, "utf8"));
        metadata["states/to.json"].releaseId = "changed";
        await writeFile(metadataFile, JSON.stringify(metadata));
        assert.equal((await verifyMigrationFiles(migrationDirectory(root, published), published)).ok, false);
        assert.equal((await readCatalogState(root, catalog, 1)).ok, false);
    }));
    it("does not publish a presentation-only snapshot as an empty migration", () => temporary(async root => {
        const draft = join(root, "draft.json");
        value(await inferSsotMigration(system, settings, root, "initial", draft));
        value(await generateSsotMigration(system, settings, root, draft));
        const before = await readFile(join(root, "catalog.json"), "utf8");
        const changed = value(decodeSqlSsot({...snapshot, entities: {...snapshot.entities,
            items: {...snapshot.entities.items, fields: {...snapshot.entities.items.fields,
                id: {...snapshot.entities.items.fields.id, visible: false, label: "Identifier", description: "Presentation only"}}}}}, mapping));
        const inferred = value(await inferSsotMigration(changed, settings, root, "presentation", draft));
        assert.equal(inferred.changes.length, 0);
        const generated = await generateSsotMigration(changed, settings, root, draft);
        assert.equal(generated.ok, false);
        if (!generated.ok) assert.equal(generated.problems[0].details.reason, "No schema changes or authored migration operations to save");
        assert.equal(await readFile(join(root, "catalog.json"), "utf8"), before);
        assert.deepEqual(await readdir(join(root, "entries")), ["0001_initial"]);
    }));
    it("authors standalone data SQL as an ordered migration with an unchanged schema", () => temporary(async root => {
        const draft = join(root, "draft.json");
        value(await inferSsotMigration(system, settings, root, "initial", draft));
        value(await generateSsotMigration(system, settings, root, draft));
        const data = value(await inferSsotMigration(system, settings, root, "data-only", draft));
        assert.equal(data.changes.length, 0);
        const published = value(await generateSsotMigration(system, settings, root, draft, {}, {text: '-- Recompute sample identifiers.\nUPDATE "app"."items" SET "id" = "id" + 1;',
            contract: {id: "increment", resourceName: "increment.sql", dependsOn: [], implementsChanges: [], reads: [],
                writes: [{schema: "app", kind: "table", name: "items", parentName: null, signature: []}], destroys: [], before: [], after: [], rowChecks: []}}));
        const verified = value(await verifyMigrationFiles(migrationDirectory(root, published), published));
        assert.equal(verified.authoring.migration.steps.length, 1);
        const script = await readFile(join(migrationDirectory(root, published), "0002_data-only.sql"), "utf8");
        assert.ok(script.includes('-- Recompute sample identifiers.'));
        assert.ok(!script.includes("GRANT "));
        assert.ok(!script.includes("-- Run with") && !script.includes("-- Phase") && !script.includes("-- 001"));
        const catalog = value(await readStoredCatalog(root));
        assert.equal(catalog.migrations.length, 2);
        assert.deepEqual(value(await readCatalogState(root, catalog, 1)).schema, value(await readCatalogState(root, catalog, 2)).schema);
    }));
    it("grants only the added table during an upgrade and omits permissions when only a column is added", () => temporary(async root => {
        const draft = join(root, "draft.json");
        value(await inferSsotMigration(system, settings, root, "initial", draft));
        value(await generateSsotMigration(system, settings, root, draft));
        const added = value(decodeSqlSsot({...snapshot, entities: {
            ...snapshot.entities, extras: {...snapshot.entities.items, name: "extras"},
        }}, mapping));
        value(await inferSsotMigration(added, settings, root, "add_table", draft));
        const published = value(await generateSsotMigration(added, settings, root, draft));
        const script = await readFile(join(migrationDirectory(root, published), "0002_add_table.sql"), "utf8");
        assert.deepEqual(script.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[^;]+;/g), [
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."extras" TO "app";',
        ]);
        const changed = value(decodeSqlSsot({...snapshot, entities: {
            ...added.ssot.entities, items: {...snapshot.entities.items, fields: {
                ...snapshot.entities.items.fields, notes: {name: "notes", type: "text", nullable: true},
            }},
        }}, mapping));
        value(await inferSsotMigration(changed, settings, root, "add_column", draft));
        const altered = value(await generateSsotMigration(changed, settings, root, draft));
        assert.ok(!altered.migration.steps.some(step => step.id === "app-permissions"));
        const alteredScript = await readFile(join(migrationDirectory(root, altered), "0003_add_column.sql"), "utf8");
        assert.ok(!alteredScript.includes("GRANT "));
        value(await verifyMigrationFiles(migrationDirectory(root, altered), altered));
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
        const options = {ssot: ssotFile, database: databaseFile, directory: store, draft: join(store, "draft.json")};
        assert.equal((await dispatchSsotAuthoring({...options, command: "infer", id: "initial"})).ok, true);
        assert.equal((await dispatchSsotAuthoring({...options, command: "generate"})).ok, true);
    }));
});

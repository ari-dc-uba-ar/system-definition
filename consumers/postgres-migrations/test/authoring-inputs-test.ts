import {strict as assert} from "node:assert";
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes,
    defineRecord, withRecords, defineEntity, defineEntities, sqlTypes, type ValidationResult} from "system-definition";
import {decodeSqlSsot} from "../src/sql-mapping";
import {inferSsotMigration, generateSsotMigration, readMigrationDraft, type SsotAuthoringRuntime} from "../src/ssot-authoring";
import {migrationDirectory, readStoredCatalog, writeJsonAtomic, invalidStore} from "../src/migration-store";
import {computeDraftRevisionHash} from "../src/draft-revision";
import {verifyMigrationFiles} from "../src/migration-integrity";
import {sha256Hex} from "../src/canonical-hash";
import type {DatabaseSettings} from "../src/database-settings";

function value<T>(result: ValidationResult<T>): T {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;}
const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const system = value(decodeSqlSsot(value(captureSystemSnapshot(context, {systemId: "cleanup", entities})), {text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean}));
const settings: DatabaseSettings = {database: {database: "unused", schema: "app"}, initialUser: {user: "admin"}, owner: {user: "owner"}, appUser: {user: "app"}};
const text = "SELECT true AS ok;\n";
const exists = (file: string) => stat(file).then(() => true, error => {if (error.code === "ENOENT") return false; throw error;});
async function temporary(body: (root: string) => Promise<void>) {
    const prefix = join(tmpdir(), "sd-authoring-cleanup-");
    const root = await mkdtemp(prefix);
    try {await body(root);} finally {assert.ok(root.startsWith(prefix)); await rm(root, {recursive: true, force: true});}
}
async function fixture(root: string, answers = join(root, "review.json")) {
    const file = join(root, "draft.json");
    const draft = value(await inferSsotMigration(system, settings, root, "initial", file));
    const required = draft.changes.filter(change => change.impact === "requiresDataCheck");
    assert.ok(required.length >= 2);
    await mkdir(join(root, "resources"));
    const decisions = required.slice(0, 2).map((change, index) => ({changeId: change.id, source: null, partitionCheck: null,
        resolution: {kind: "check", run: {name: index === 0 ? "owned.sql" : "shared.sql", kind: "check", contentHash: sha256Hex(text)}}}));
    for (const decision of decisions) await writeFile(join(root, "resources", decision.resolution.run.name), text);
    await writeFile(answers, JSON.stringify({id: draft.id, revisionHash: draft.revisionHash, decisions}));
    const run = spawnSync(process.execPath, [resolve(__dirname, "../src/cli-main.js"), "resolve", "--draft", file, "--answers", answers], {encoding: "utf8", timeout: 10000});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const runtime: SsotAuthoringRuntime = {async readSql(ref) {return {ok: true, value: await readFile(join(root, "resources", ref.name), "utf8")};}};
    return {file, answers, runtime};
}

describe("Consumed migration authoring inputs", () => {
    it("removes consumed answers, checks and empty resource directories only after publication", () => temporary(async root => {
        const {file, answers, runtime} = await fixture(root);
        assert.equal(await exists(file + ".inputs.json"), true);
        const published = value(await generateSsotMigration(system, settings, root, file, runtime));
        value(await verifyMigrationFiles(migrationDirectory(root, published), published));
        assert.equal(value(await readStoredCatalog(root)).migrations.length, 1);
        for (const path of [file, file + ".states.json", file + ".inputs.json", answers, join(root, "resources")]) assert.equal(await exists(path), false, path);
    }));

    it("retains shared and unrelated resources while removing the current draft's owned input", () => temporary(async root => {
        const {file, answers, runtime} = await fixture(root);
        const other = value(await readMigrationDraft(file));
        other.decisions = other.decisions.filter(decision => decision.resolution.kind === "check" && decision.resolution.run.name === "shared.sql");
        other.revisionHash = value(computeDraftRevisionHash(other));
        await writeJsonAtomic(join(root, "another-draft.json"), other);
        await writeFile(join(root, "resources", "unused.sql"), text);
        value(await generateSsotMigration(system, settings, root, file, runtime));
        assert.equal(await exists(answers), false);
        assert.equal(await exists(join(root, "resources", "owned.sql")), false);
        assert.equal(await readFile(join(root, "resources", "shared.sql"), "utf8"), text);
        assert.equal(await readFile(join(root, "resources", "unused.sql"), "utf8"), text);
        assert.equal(await exists(join(root, "another-draft.json")), true);
    }));

    it("preserves all authoring inputs when generation fails", () => temporary(async root => {
        const {file, answers} = await fixture(root);
        const result = await generateSsotMigration(system, settings, root, file, {async readSql() {return invalidStore("test read failure");}});
        assert.equal(result.ok, false);
        assert.equal(value(await readStoredCatalog(root)).migrations.length, 0);
        for (const path of [file, file + ".states.json", file + ".inputs.json", answers, join(root, "resources", "owned.sql"), join(root, "resources", "shared.sql")]) assert.equal(await exists(path), true, path);
    }));

    it("preserves answers and resources changed since they were consumed", () => temporary(async root => {
        const {file, answers} = await fixture(root);
        await writeFile(answers, "{}");
        await writeFile(join(root, "resources", "owned.sql"), "SELECT false AS ok;\n");
        value(await generateSsotMigration(system, settings, root, file, {async readSql() {return {ok: true, value: text};}}));
        assert.equal(await readFile(answers, "utf8"), "{}");
        assert.equal(await readFile(join(root, "resources", "owned.sql"), "utf8"), "SELECT false AS ok;\n");
    }));

    it("keeps consumed answers outside the catalog directory", () => temporary(async root => {
        const catalog = join(root, "catalog");
        await mkdir(catalog);
        const {file, answers, runtime} = await fixture(catalog, join(root, "external-review.json"));
        value(await generateSsotMigration(system, settings, catalog, file, runtime));
        assert.equal(await exists(answers), true);
        assert.equal(await exists(join(catalog, "resources")), false);
    }));
});

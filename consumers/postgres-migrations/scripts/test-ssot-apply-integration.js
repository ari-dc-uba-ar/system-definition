"use strict";
const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const {mkdtemp, readFile, writeFile, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {join, resolve} = require("node:path");
const {randomUUID} = require("node:crypto");
const {commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes, defineRecord, withRecords, defineEntity, defineEntities, captureSystemSnapshot, sqlTypes} = require("system-definition");
const {createPostgresScratch, connectPostgres, quotePgIdentifier, withMigrationLock} = require("../dist/src/index.js");
const value = result => {assert.equal(result.ok, true, JSON.stringify(result.problems)); return result.value;};

async function main() {
    const admin = {user: process.env.PG_TEST_ADMIN_USER || process.env.PGUSER, password: process.env.PG_TEST_ADMIN_PASSWORD || process.env.PGPASSWORD};
    const provider = createPostgresScratch(admin, []), handle = value(await provider.create("clean-target"));
    const prefix = "sd_apply_test_" + randomUUID().replaceAll("-", "");
    const settings = {database: {database: handle.id, schema: "app"}, initialUser: admin,
        owner: {user: prefix + "_owner", password: "fixture-owner"}, appUser: {user: prefix + "_app", password: "fixture-app"}};
    const root = await mkdtemp(join(tmpdir(), "sd-ssot-apply-")), store = join(root, "migrations"), systemFile = join(root, "system.cjs"), databaseFile = join(root, "database.cjs");
    let owner, app, releaseLock, held;
    function snapshot(tag = false, required = false) {
        const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
        const fields = {id: {type: "integer"}, name: {type: "text"}};
        if (tag) fields.tag = {type: "text"};
        if (required) fields.required = {type: "text", nullable: false};
        const context = withRecords(types, {item: defineRecord(types, fields)});
        const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
        return value(captureSystemSnapshot(context, {systemId: "ssot-apply", entities}));
    }
    async function model(tag = false, required = false) {
        await writeFile(systemFile, `exports.ssot=${JSON.stringify(snapshot(tag, required))}; exports.sqlMapping=${JSON.stringify({text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean})};`);
    }
    function run(command, options = [], code = 0) {
        const result = spawnSync(process.execPath, [resolve(__dirname, "../dist/src/cli-main.js"), command, "--ssot", systemFile, "--database", databaseFile, "--directory", store, ...options], {encoding: "utf8", timeout: 60000, env: {...process.env, CI: "true"}});
        assert.equal(result.error, undefined);
        assert.equal(result.status, code, result.stderr + result.stdout.slice(0, 2500));
        return JSON.parse(result.stdout);
    }
    try {
        await model();
        await writeFile(databaseFile, `exports.databaseSettings={database:${JSON.stringify(settings.database)},owner:${JSON.stringify(settings.owner)},appUser:${JSON.stringify(settings.appUser)},initialUser:{user:process.env.PG_TEST_ADMIN_USER||process.env.PGUSER,password:process.env.PG_TEST_ADMIN_PASSWORD||process.env.PGPASSWORD}};`);
        const installed = value(run("apply"));
        assert.deepEqual(installed.migrations.map(migration => migration.applied), [true]);
        owner = await connectPostgres({...settings.database, ...settings.owner});
        app = await connectPostgres({...settings.database, ...settings.appUser});
        await app.query('INSERT INTO app.items (id, name) VALUES (1, $1)', ["original"]);
        await assert.rejects(app.query('ALTER TABLE app.items ADD COLUMN denied text', []));
        const tables = await owner.query("SELECT tablename FROM pg_tables WHERE schemaname = 'app_migrations' ORDER BY tablename", []);
        assert.deepEqual(tables.rows.map(row => row.tablename), ["execution_attempt", "installation", "migration_history"]);
        assert.equal(value(run("apply")).installation.current.releaseHash, installed.installation.current.releaseHash);
        assert.deepEqual(value(run("status")).migrations.map(migration => migration.applied), [true]);

        await owner.query('ALTER TABLE app.items ADD COLUMN rogue text', []);
        assert.equal(run("apply", [], 3).problems[0].messageKey, "migration.schemaDrift");
        await owner.query('ALTER TABLE app.items DROP COLUMN rogue', []);
        const initial = JSON.parse(await readFile(join(store, "catalog.json"), "utf8")).migrations[0];
        const sqlPath = join(store, "entries", initial.migration.id, "generated", initial.migration.steps[0].run.contentHash + ".sql"), bytes = await readFile(sqlPath);
        const changed = Buffer.from(bytes); changed[0] ^= 1; await writeFile(sqlPath, changed);
        assert.equal(run("apply", [], 3).problems[0].messageKey, "migration.checksumMismatch");
        await writeFile(sqlPath, bytes);
        await owner.query('GRANT CREATE ON SCHEMA app TO ' + quotePgIdentifier(settings.appUser.user), []);
        assert.equal(run("apply", [], 3).problems[0].messageKey, "migration.permissionsInvalid");
        await owner.query('REVOKE CREATE ON SCHEMA app FROM ' + quotePgIdentifier(settings.appUser.user), []);

        let locked;
        const acquired = new Promise(resolve => {locked = resolve;});
        held = withMigrationLock({openTarget: () => connectPostgres({...settings.database, ...settings.owner})}, {systemId: "ssot-apply", schemas: ["app"]}, 1000,
            async () => {locked(); await new Promise(resolve => {releaseLock = resolve;}); return {ok: true, value: true};});
        await acquired;
        assert.equal(run("apply", [], 4).problems[0].messageKey, "migration.lockTimeout");
        releaseLock(); value(await held); held = undefined;
        await model(true);
        assert.equal(value(run("apply")).migrations.length, 2);
        assert.deepEqual((await app.query('SELECT id, name, tag FROM app.items', [])).rows, [{id: 1, name: "original", tag: null}]);
        await model(true, true);
        const pending = run("apply", [], 4);
        assert.ok(pending.problems.some(problem => problem.messageKey === "migration.authoringPending"));
        assert.equal((await owner.query('SELECT count(*)::integer AS count FROM app_migrations.migration_history', [])).rows[0].count, 2);
        await model(true);
        const contractFile = join(root, "contract.json"), sqlFile = join(root, "data.sql");
        const contract = {id: "update-name", resourceName: "update-name.sql", dependsOn: [], implementsChanges: [], reads: [], writes: [{schema: "app", kind: "table", name: "items", parentName: null, signature: []}], destroys: [], before: [], after: [], rowChecks: []};
        await writeFile(contractFile, JSON.stringify(contract));
        await writeFile(sqlFile, "UPDATE app.items SET name = 'moved';");
        value(run("data", ["--id", "move-name", "--sql", sqlFile, "--contract", contractFile]));
        assert.equal(value(run("apply")).migrations.length, 3);
        await writeFile(sqlFile, "UPDATE app.items SET name = 'must roll back'; SELECT 1 / 0;");
        value(run("data", ["--id", "fail-data", "--sql", sqlFile, "--contract", contractFile]));
        assert.equal(run("apply", [], 4).ok, false);
        assert.equal((await app.query('SELECT name FROM app.items', [])).rows[0].name, "moved");
        const status = value(run("status"));
        assert.deepEqual(status.migrations.map(migration => migration.applied), [true, true, true, false]);
        assert.equal(status.installation.current.releaseId, "move-name");
        assert.equal((await owner.query("SELECT state FROM app_migrations.execution_attempt ORDER BY started_at DESC LIMIT 1", [])).rows[0].state, "failed");
        console.log("SSOT CLI fresh install, roles, idempotence, integrity/drift/permission gates, concurrency, upgrades, decisions and transactional data failure verified");
    } finally {
        releaseLock?.(); if (held) await held;
        await app?.close(); await owner?.close();
        value(await provider.destroy(handle));
        const cleanup = await connectPostgres(admin);
        try {for (const user of [settings.owner.user, settings.appUser.user]) {
            assert.ok(user.startsWith(prefix + "_"));
            await cleanup.query("DROP ROLE IF EXISTS " + quotePgIdentifier(user), []);
        }} finally {await cleanup.close();}
        await rm(root, {recursive: true, force: true});
    }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});

"use strict";
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const {createPostgresScratch, connectPostgres} = require("../dist/src/pg-session.js");
const {provisionDatabase, verifyDatabasePermissions} = require("../dist/src/database-permissions.js");
const {quotePgIdentifier} = require("../dist/src/pg-sql.js");
const value = result => {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;};
async function main() {
    const admin = {user: process.env.PG_TEST_ADMIN_USER || process.env.PGUSER, password: process.env.PG_TEST_ADMIN_PASSWORD || process.env.PGPASSWORD};
    const provider = createPostgresScratch(admin, []);
    const handle = value(await provider.create("clean-target"));
    const prefix = "sd_role_test_" + randomUUID().replaceAll("-", "");
    const settings = {database: {database: handle.id, schema: "app"}, initialUser: admin,
        owner: {user: prefix + "_owner", password: "fixture-owner"}, appUser: {user: prefix + "_app", password: "fixture-app"}};
    let owner, app;
    try {
        value(await provisionDatabase(handle.session, settings));
        owner = await connectPostgres({...settings.database, ...settings.owner});
        app = await connectPostgres({...settings.database, ...settings.appUser});
        await owner.query('CREATE TABLE "app"."items" (id integer PRIMARY KEY)', []);
        const expected = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: [{kind: "table", identity: {schema: "app", kind: "table", name: "items", parentName: null, signature: []}, persistence: "permanent", relationKind: "r"}]};
        value(await verifyDatabasePermissions(owner, settings, expected));
        await app.query('INSERT INTO "app"."items" VALUES (1)', []);
        assert.equal((await owner.query('SELECT count(*)::integer AS count FROM "app"."items"', [])).rows[0].count, 1);
        await assert.rejects(app.query('ALTER TABLE "app"."items" ADD COLUMN denied text', []));
        await assert.rejects(app.query('CREATE TABLE "app"."denied" (id integer)', []));
        await owner.query('GRANT CREATE ON SCHEMA "app" TO ' + quotePgIdentifier(settings.appUser.user), []);
        assert.equal((await verifyDatabasePermissions(owner, settings, expected)).ok, false);
        await owner.query('REVOKE CREATE ON SCHEMA "app" FROM ' + quotePgIdentifier(settings.appUser.user), []);
        value(await verifyDatabasePermissions(owner, settings, expected));
        const rows = await handle.session.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1", [settings.appUser.user]);
        assert.deepEqual(rows.rows[0], {rolsuper: false, rolcreatedb: false, rolcreaterole: false});
        console.log("PostgreSQL owner/app provisioning, DML-only access and permission drift verified in an owned scratch database");
    } finally {
        await app?.close(); await owner?.close();
        value(await provider.destroy(handle));
        const cleanup = await connectPostgres(admin);
        try {for (const user of [settings.owner.user, settings.appUser.user]) {
            assert.ok(user.startsWith(prefix + "_") && prefix.startsWith("sd_role_test_"));
            await cleanup.query("DROP ROLE IF EXISTS " + quotePgIdentifier(user), []);
        }} finally {await cleanup.close();}
    }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});

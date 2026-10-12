import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {provisionDatabase, verifyDatabasePermissions} from "../src/database-permissions";
import type {DatabaseSettings} from "../src/database-settings";
import type {PgSession, PgSchemaInfo} from "../src/pg-schema";
const settings: DatabaseSettings = {database: {database: "test", schema: "app"}, initialUser: {user: "admin"}, owner: {user: "owner", password: "fixture-owner"}, appUser: {user: "app", password: "fixture-app"}};
describe("owner/app provisioning and permission verification", () => {
    it("creates missing roles and schema with one administrative transaction and parameterized role formatting", async () => {
        const calls: string[] = [];
        const session: PgSession = {async query(sql, params) {
            calls.push(sql);
            if (sql.startsWith("SELECT format")) return {rows: [{sql: 'CREATE ROLE "' + params[0] + '" LOGIN'}], rowCount: 1};
            if (sql.includes("nspowner")) return {rows: [{owner: "owner"}], rowCount: 1};
            return {rows: [], rowCount: 0};
        }, async close() {}};
        assert.equal((await provisionDatabase(session, settings)).ok, true);
        assert.ok(calls.includes("BEGIN") && calls.includes("COMMIT"));
        assert.equal(calls.filter(sql => sql.startsWith("CREATE ROLE")).length, 2);
        assert.ok(calls.some(sql => sql.includes('AUTHORIZATION "owner"')));
        assert.ok(calls.some(sql => sql.includes("ALTER DEFAULT PRIVILEGES")));
    });
    it("blocks an administrative app role and rolls back a schema owned by another user", async () => {
        const blocked: PgSession = {async query() {return {rows: [{rolname: "app", rolcanlogin: true, rolsuper: true}], rowCount: 1};}, async close() {}};
        assert.equal((await provisionDatabase(blocked, settings)).ok, false);
        const calls: string[] = [];
        const wrong: PgSession = {async query(sql) {
            calls.push(sql);
            if (sql.startsWith("SELECT format")) return {rows: [{sql: "CREATE ROLE fixture"}], rowCount: 1};
            if (sql.includes("nspowner")) return {rows: [{owner: "other"}], rowCount: 1};
            return {rows: [], rowCount: 0};
        }, async close() {}};
        assert.equal((await provisionDatabase(wrong, settings)).ok, false);
        assert.ok(calls.includes("ROLLBACK"));
        assert.ok(!calls.includes("COMMIT"));
    });
    it("checks every managed table using the configured identities without changing permissions", async () => {
        const expected: PgSchemaInfo = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: [{kind: "table", identity: {schema: "app", kind: "table", name: "items", parentName: null, signature: []}, persistence: "permanent", relationKind: "r"}]};
        let valid = true;
        const session: PgSession = {async query(sql, params) {
            assert.ok(sql.startsWith("SELECT"));
            assert.deepEqual(params, ["owner", "app", "app", '["items"]']);
            return {rows: [{ok: valid}], rowCount: 1};
        }, async close() {}};
        assert.equal((await verifyDatabasePermissions(session, settings, expected)).ok, true);
        valid = false;
        assert.equal((await verifyDatabasePermissions(session, settings, expected)).ok, false);
    });
});

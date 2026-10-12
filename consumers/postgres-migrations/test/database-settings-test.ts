import {strict as assert} from "node:assert";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import type {ClientConfig} from "pg";
import {loadDatabaseSettings, type DatabaseSettings} from "../src/database-settings";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type SettingsContract = Expect<Equal<DatabaseSettings, {database: ClientConfig & {database: string; schema: string}; initialUser: ClientConfig & {user: string}; owner: ClientConfig & {user: string}; appUser: ClientConfig & {user: string}}>>;
type LoaderContract = Expect<Equal<typeof loadDatabaseSettings, (file: string) => Promise<ValidationResult<DatabaseSettings>>>>;
const contracts: [SettingsContract, LoaderContract] = [true, true];

async function fixture(settings: unknown, body: (file: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "sd-database-settings-"));
    try {
        const file = join(root, "database.mjs");
        await writeFile(file, `export const databaseSettings = ${JSON.stringify(settings)};`);
        await body(file);
    } finally { await rm(root, {recursive: true, force: true}); }
}

describe("database settings", () => {
    it("receives the database, provisioning connection and role identities from the application", () => fixture({database: {database: "example", schema: "app", host: "db.example", port: 5432}, initialUser: {user: "admin", password: "fixture-secret"}, owner: {user: "schema_owner"}, appUser: {user: "app_user"}}, async file => {
        assert.deepEqual(contracts, [true, true]);
        assert.deepEqual(await loadDatabaseSettings(file), {ok: true, value: {database: {database: "example", schema: "app", host: "db.example", port: 5432}, initialUser: {user: "admin", password: "fixture-secret"}, owner: {user: "schema_owner"}, appUser: {user: "app_user"}}});
    }));
    it("requires database, provisioning user, owner and app user", async () => {
        for (const settings of [null, {database: {database: "example"}, owner: {user: "schema_owner"}}, {database: {database: ""}, owner: {user: "schema_owner"}, appUser: {user: "app_user"}},
            {database: {database: "example", schema: "app"}, owner: {user: "schema_owner"}, appUser: {user: "app_user"}},
            {database: {database: "example", schema: "app"}, initialUser: {user: " "}, owner: {user: "schema_owner"}, appUser: {user: "app_user"}}]) {
            await fixture(settings, async file => {assert.equal((await loadDatabaseSettings(file)).ok, false);});
        }
    });
    it("rejects an app user that is also the owner", () => fixture({database: {database: "example", schema: "app"}, initialUser: {user: "admin"}, owner: {user: "same_role"}, appUser: {user: "same_role"}}, async file => {
        assert.equal((await loadDatabaseSettings(file)).ok, false);
    }));
});

import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {completeMigrationCatalog, type PublishedMigrationInfo, type ReleaseRefInfo, type ValidationResult} from "system-definition";
import {describeMigrationHistory, checkHistoryHeadDrift, readMigrationHistory, readMigrationStatus, type MigrationHistoryStateInfo} from "../src/migration-history";
import {bootstrapHistory} from "../src/history-schema";
import type {InstallationInfo, MigrationHistoryInfo} from "../src/journal-contracts";
import type {PgSchemaInfo, PgSession} from "../src/pg-schema";

const ref = (id: string, digit: string): ReleaseRefInfo => ({systemId: "history", releaseId: id, releaseHash: digit.repeat(64)});
const A = ref("A", "1"), B = ref("B", "2"), C = ref("C", "3");
const migration = (from: ReleaseRefInfo, to: ReleaseRefInfo, digit: string): PublishedMigrationInfo => ({migrationHash: digit.repeat(64), migration: {
    id: from.releaseId + "-" + to.releaseId, from, to, description: "history fixture", before: [], after: [],
    steps: [{id: "sql", run: {name: "migration.sql", kind: "sql", contentHash: "7".repeat(64)}}],
}});
const AB = migration(A, B, "4"), BC = migration(B, C, "5");
function value<T>(result: ValidationResult<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value; }
const catalog = value(completeMigrationCatalog([A, B, C], [AB, BC]));
const installation: InstallationInfo = {installationId: "test", systemId: "history", schemas: ["app"], baseline: A, current: B, journalFormatVersion: 1};
const applied: MigrationHistoryInfo = {installationId: "test", ordinal: 1, migrationId: AB.migration.id, migrationHash: AB.migrationHash, from: A, to: B, committedAt: "2026-10-11T00:00:00.000Z"};
const empty: PgSchemaInfo = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []};
const future: PgSchemaInfo = {...empty, objects: [{kind: "table", identity: {schema: "app", kind: "table", name: "future", parentName: null, signature: []}, persistence: "permanent", relationKind: "r"}]};
const scope = {systemId: "history", schemas: ["app"]};
const config = {schema: "journal"};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type DescriptionContract = Expect<Equal<ReturnType<typeof describeMigrationHistory>, ValidationResult<MigrationHistoryStateInfo>>>;
const contract: DescriptionContract = true;

function session(): PgSession {
    return {async query(sql) {
        if (sql.includes("row_to_json(i)")) return {rows: [{installation: {
            installation_id: "test", system_id: "history", schemas: ["app"], journal_format_version: 1,
            baseline_system_id: A.systemId, baseline_release_id: A.releaseId, baseline_release_hash: A.releaseHash,
            current_system_id: B.systemId, current_release_id: B.releaseId, current_release_hash: B.releaseHash,
        }, history: [{installation_id: "test", ordinal: 1, migration_id: applied.migrationId, migration_hash: applied.migrationHash,
            from_system_id: A.systemId, from_release_id: A.releaseId, from_release_hash: A.releaseHash,
            to_system_id: B.systemId, to_release_id: B.releaseId, to_release_hash: B.releaseHash, committed_at: applied.committedAt}]}], rowCount: 1};
        assert.match(sql, /^\s*WITH managed_schemas/);
        return {rows: [{schema_name: "app", object_kind: null}], rowCount: 1};
    }, async close() {throw new Error("Caller owns the session");}};
}

describe("minimal migration history", () => {
    it("reads catalog status with one journal SELECT, without schema inspection or transaction control", async () => {
        let queries = 0;
        const journalOnly: PgSession = {async query(sql, values) {
            queries++;
            assert.match(sql, /^SELECT row_to_json/);
            return session().query(sql, values);
        }, async close() {throw new Error("Caller owns the session");}};
        const state = value(await readMigrationStatus(journalOnly, config, scope, catalog));
        assert.deepEqual(state.migrations.map(entry => entry.applied), [true, false]);
        assert.equal(queries, 1);
        assert.equal((await readMigrationStatus(journalOnly, config, {...scope, systemId: "another"}, catalog)).ok, false);
        assert.equal(queries, 1);
    });
    it("derives applied and pending entries from the catalog and database pointer", () => {
        assert.equal(contract, true);
        const state = value(describeMigrationHistory(installation, [applied], catalog));
        assert.deepEqual(state.migrations.map(entry => [entry.position, entry.migration.id, entry.applied]), [[1, "A-B", true], [2, "B-C", false]]);
        assert.ok(value(describeMigrationHistory(null, [], catalog)).migrations.every(entry => !entry.applied));
    });
    it("rejects changed, missing or reordered applied migrations and inconsistent pointers", () => {
        assert.equal(describeMigrationHistory(installation, [applied], {...catalog, migrations: [{...AB, migrationHash: "6".repeat(64)}, BC]}).ok, false);
        assert.equal(describeMigrationHistory(installation, [applied], value(completeMigrationCatalog([B, C], [BC]))).ok, false);
        assert.equal(describeMigrationHistory(installation, [applied], {...catalog, migrations: [BC, AB]}).ok, false);
        assert.equal(describeMigrationHistory({...installation, current: C}, [applied], catalog).ok, false);
        assert.equal(describeMigrationHistory(null, [applied], catalog).ok, false);
    });
    it("checks the recorded head rather than the latest pending target", async () => {
        const state = value(await readMigrationHistory(session(), config, scope, catalog, {[B.releaseHash]: empty, [C.releaseHash]: future}));
        assert.equal(state.installation?.current.releaseId, "B");
        assert.equal(state.migrations[1]?.applied, false);
        assert.equal((await readMigrationHistory(session(), config, scope, catalog, {[C.releaseHash]: future})).ok, false);
        assert.equal((await readMigrationHistory(session(), config, scope, catalog, {[B.releaseHash]: future})).ok, false);
    });
    it("normalizes drift checks and preserves unsupported database features", async () => {
        assert.equal((await checkHistoryHeadDrift(empty, {schema: empty, unknown: [], excluded: []})).ok, true);
        const drift = await checkHistoryHeadDrift(empty, {schema: future, unknown: [], excluded: []});
        assert.equal(drift.ok, false);
        if (!drift.ok) assert.equal(drift.problems[0]?.messageKey, "migration.schemaDrift");
        assert.equal((await checkHistoryHeadDrift(empty, {schema: empty, excluded: [], unknown: [{object: {schema: "app", kind: "trigger", name: "unknown", parentName: "table", signature: []}, feature: "trigger"}]})).ok, false);
    });
    it("initializes only the two history tables without deployment state", async () => {
        const queries: string[] = [];
        const db: PgSession = {async query(sql) {queries.push(sql); return {rows: [], rowCount: 0};}, async close() {}};
        assert.equal((await bootstrapHistory(db, config)).ok, true);
        assert.equal(queries.length, 3);
        assert.equal(queries.filter(sql => sql.includes("CREATE TABLE")).length, 2);
        assert.ok(queries.every(sql => !/execution_attempt|verification_run|deployment_readiness|preparation_attempt/.test(sql)));
    });
});

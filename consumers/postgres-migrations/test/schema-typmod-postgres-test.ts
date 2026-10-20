import {strict as assert} from "node:assert";
import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import {inspectSchema} from "../src/inspect-schema";
import {compareSchemas} from "../src/compare-schema";
import type {PgObjectInfo, PgSession} from "../src/pg-schema";
import {generateCreate} from "../src/generate-create";
import {generateStructureSql} from "../src/generate-structure";
import {inferStructureChanges} from "../src/infer";
import {normalizePgSchema} from "../src/normalize-schema";
import {decodeSqlSsot} from "../src/sql-mapping";
import {captureMigrationState, jsonBytes, readStateBytes} from "../src/migration-store";
import {assessSchema} from "../src/assessment";
import {snapshot as keySnapshot, mapping as keyMapping, storage as keyStorage} from "./fixtures/key-storage-fixture";

// Use an explicitly supplied disposable database. Never load application .env files here.
const connectionString = process.env.POSTGRES_HANDOFF_TEST_URL;
const integration = connectionString ? describe : describe.skip;

function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}

async function withScratchSchema(run: (session: PgSession, schema: string) => Promise<void>): Promise<void> {
    const client = new Client({connectionString});
    await client.connect();
    const schema = `handoff_typmod_${randomUUID().replaceAll("-", "")}`;
    const session: PgSession = {
        async query(text, parameters) {
            const result = await client.query<Record<string, unknown>>(text, [...parameters]);
            return {rows: result.rows, rowCount: result.rowCount};
        },
        async close() {throw new Error("The fixture owns this connection");},
    };
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query(`CREATE SCHEMA "${schema}"`);
        await run(session, schema);
    } finally {
        // All fixtures and changes are rolled back, including when an assertion fails.
        try {await client.query("ROLLBACK");} finally {await client.end();}
    }
}

function column(objects: readonly PgObjectInfo[], name: string): Extract<PgObjectInfo, {kind: "column"}> {
    const found = objects.find(object => object.kind === "column" && object.identity.name === name);
    assert.ok(found?.kind === "column", `Missing column ${name}`);
    return found;
}

integration("existing-schema handoff: PostgreSQL type modifiers", () => {
    it("retains bounded character, numeric and timestamp declarations read from real catalogs", async () => {
        await withScratchSchema(async (session, schema) => {
            await session.query(`CREATE TABLE "${schema}".items (
                label varchar(64), unbounded varchar, amount numeric(12, 2), rounded numeric(12, -2), recorded_at timestamp(3), exact_time time(0), zoned_at timestamp(0) with time zone
            )`, []);
            const observed = value(await inspectSchema(session, {schemas: [schema], excluded: []}));
            assert.deepEqual(observed.unknown, []);
            assert.deepEqual(column(observed.schema.objects, "label").type.modifiers, ["64"]);
            assert.deepEqual(column(observed.schema.objects, "unbounded").type.modifiers, []);
            assert.deepEqual(column(observed.schema.objects, "amount").type.modifiers, ["12", "2"]);
            assert.deepEqual(column(observed.schema.objects, "recorded_at").type.modifiers, ["3"]);
            assert.deepEqual(column(observed.schema.objects, "rounded").type.modifiers, ["12", "-2"]);
            assert.deepEqual(column(observed.schema.objects, "exact_time").type.modifiers, ["0"]);
            assert.deepEqual(column(observed.schema.objects, "zoned_at").type.modifiers, ["0"]);
        });
    });

    it("detects varchar length drift even when all names and other attributes match", async () => {
        await withScratchSchema(async (session, schema) => {
            await session.query(`CREATE TABLE "${schema}".items (label varchar(64))`, []);
            const before = value(await inspectSchema(session, {schemas: [schema], excluded: []}));
            await session.query(`ALTER TABLE "${schema}".items ALTER COLUMN label TYPE varchar(128)`, []);
            const after = value(await inspectSchema(session, {schemas: [schema], excluded: []}));
            const compared = value(compareSchemas(before.schema, after));
            assert.equal(compared.equal, false, "A changed length must not be accepted as the recorded schema");
            assert.ok(compared.differences.some(difference =>
                difference.path.includes("label") && difference.path.includes("modifiers")));
        });
    });
});

integration("existing-schema handoff: generated SQL preserves real database behavior", () => {
    for (const generation of ["clean", "incremental"] as const) {
        for (const mode of ["BY DEFAULT", "ALWAYS"] as const) {
            it(`round-trips ${generation} creation with ${mode} identity, CHECK and partial uniqueness`, async () => {
                await withScratchSchema(async (session, namespace) => {
                    const table = `"${namespace}".items`;
                    await session.query(`CREATE TABLE ${table} (
                        id bigint GENERATED ${mode} AS IDENTITY CONSTRAINT legacy_primary PRIMARY KEY,
                        counter integer NOT NULL DEFAULT 0 CONSTRAINT legacy_nonnegative CHECK (counter >= 0),
                        slug varchar(64) NOT NULL, active boolean NOT NULL DEFAULT true
                    )`, []);
                    await session.query(`CREATE UNIQUE INDEX legacy_active_slug ON ${table} (slug) WHERE active`, []);
                    const recorded = value(await inspectSchema(session, {schemas: [namespace], excluded: []}));
                    assert.deepEqual(recorded.unknown, []);
                    const target = await normalizePgSchema(recorded.schema);
                    let statements: readonly string[];
                    if (generation === "clean") {
                        statements = value(generateCreate(target)).statements.map(statement => statement.text);
                    } else {
                        const base = {
                            from: {systemId: "handoff", releaseId: "empty", releaseHash: "1".repeat(64)},
                            to: {systemId: "handoff", releaseId: "adopted", releaseHash: "2".repeat(64)},
                            fromSnapshotHash: "3".repeat(64), toSnapshotHash: "4".repeat(64),
                            fromPersistenceHash: "5".repeat(64), toPersistenceHash: "6".repeat(64),
                        };
                        const empty = {...target, objects: []};
                        const changes = value(inferStructureChanges(base, empty, target, []));
                        statements = value(generateStructureSql(changes, empty, target)).map(statement => statement.text);
                    }
                    // This is the test-owned table; its replacement stays inside the fixture transaction.
                    await session.query(`DROP TABLE ${table}`, []);
                    for (const statement of statements) await session.query(statement, []);
                    const observed = value(await inspectSchema(session, {schemas: [namespace], excluded: []}));
                    const compared = value(compareSchemas(target, {...observed, schema: await normalizePgSchema(observed.schema)}));
                    assert.deepEqual(compared, {equal: true, differences: []});

                    const inserted = await session.query(`INSERT INTO ${table} (slug) VALUES ('same') RETURNING id`, []);
                    assert.equal(String(inserted.rows[0]?.id), "1");
                    await session.query(`INSERT INTO ${table} (slug, active) VALUES ('same', false)`, []);
                    for (const [sql, code] of [
                        [`INSERT INTO ${table} (slug, counter) VALUES ('bad', -1)`, "23514"],
                        [`INSERT INTO ${table} (slug) VALUES ('same')`, "23505"],
                    ]) {
                        await session.query("SAVEPOINT expected_rejection", []);
                        await assert.rejects(session.query(sql, []), error =>
                            typeof error === "object" && error !== null && "code" in error && error.code === code);
                        await session.query("ROLLBACK TO SAVEPOINT expected_rejection", []);
                    }
                    if (mode === "ALWAYS") {
                        await session.query("SAVEPOINT expected_identity_rejection", []);
                        await assert.rejects(session.query(`INSERT INTO ${table} (id, slug) VALUES (100, 'manual')`, []), error =>
                            typeof error === "object" && error !== null && "code" in error && error.code === "428C9");
                        await session.query("ROLLBACK TO SAVEPOINT expected_identity_rejection", []);
                    } else {
                        await session.query(`INSERT INTO ${table} (id, slug) VALUES (100, 'manual')`, []);
                    }
                });
            });
        }
    }
});

integration("catalog inspection is independent of the caller search_path", () => {
    for (const kind of ["index", "foreignKey"] as const) {
        it(`does not report ${kind} drift when only relation visibility changes`, async () => {
            await withScratchSchema(async (session, namespace) => {
                await session.query(`CREATE TABLE "${namespace}".parents (id bigint PRIMARY KEY)`, []);
                await session.query(`CREATE TABLE "${namespace}".items (id bigint PRIMARY KEY, parent_id bigint REFERENCES "${namespace}".parents (id))`, []);
                await session.query(`CREATE INDEX items_parent_idx ON "${namespace}".items (parent_id)`, []);
                await session.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)", []);
                const qualified = value(await inspectSchema(session, {schemas: [namespace], excluded: []}));
                const path = `${namespace}, pg_catalog`;
                await session.query("SELECT pg_catalog.set_config('search_path', $1, true)", [path]);
                const visible = value(await inspectSchema(session, {schemas: [namespace], excluded: []}));
                const unchanged = await session.query("SHOW search_path", []);
                assert.equal(unchanged.rows[0]?.search_path, path, "Inspection must preserve the caller's configuration");
                const select = (object: PgObjectInfo) => kind === "index" ? object.kind === "index" && object.ownerConstraint === null
                    : object.kind === "constraint" && object.constraintKind === "foreignKey";
                assert.deepEqual(visible.schema.objects.filter(select), qualified.schema.objects.filter(select), "Raw catalog descriptions must also be stable");
                const expected = await normalizePgSchema({...qualified.schema, objects: qualified.schema.objects.filter(select)});
                const actual = await normalizePgSchema({...visible.schema, objects: visible.schema.objects.filter(select)});
                const compared = value(compareSchemas(expected, {...visible, schema: actual}));
                assert.equal(compared.equal, true, JSON.stringify(compared.differences.slice(0, 1)));
            });
        });
    }

    it("restores caller settings and preserves uncommitted work after a catalog query error", async () => {
        await withScratchSchema(async (session, namespace) => {
            await session.query(`CREATE TABLE "${namespace}".pending (id integer)`, []);
            await session.query(`INSERT INTO "${namespace}".pending (id) VALUES (1)`, []);
            const path = `${namespace}, pg_catalog`;
            await session.query("SELECT pg_catalog.set_config('search_path', $1, true)", [path]);
            const failed = await inspectSchema({
                query: (text, values) => session.query(text.includes("WITH managed_schemas") ? "SELECT 1/0" : text, values),
                close: session.close,
            }, {schemas: [namespace], excluded: []});
            assert.equal(failed.ok, false);
            if (!failed.ok) assert.equal(failed.problems[0]?.messageKey, "migration.inspectionFailed");
            assert.equal((await session.query("SHOW search_path", [])).rows[0]?.search_path, path);
            assert.deepEqual((await session.query(`SELECT id FROM "${namespace}".pending`, [])).rows, [{id: 1}]);
            await session.query(`INSERT INTO "${namespace}".pending (id) VALUES (2)`, []);
        });
    });

    it("scopes standalone inspection and leaves no transaction or session configuration behind", async () => {
        const client = new Client({connectionString});
        await client.connect();
        const session: PgSession = {
            async query(text, values) {
                const result = await client.query<Record<string, unknown>>(text, [...values]);
                return {rows: result.rows, rowCount: result.rowCount};
            },
            async close() {throw new Error("The fixture owns this connection");},
        };
        try {
            const original = (await session.query("SHOW search_path", [])).rows;
            value(await inspectSchema(session, {schemas: ["public"], excluded: []}));
            assert.deepEqual((await session.query("SHOW search_path", [])).rows, original);
            await assert.rejects(session.query("SAVEPOINT should_be_idle", []), {code: "25P01"});
            const failed = await inspectSchema({
                query: (text, values) => session.query(text.includes("WITH managed_schemas") ? "SELECT 1/0" : text, values),
                close: session.close,
            }, {schemas: ["public"], excluded: []});
            assert.equal(failed.ok, false);
            assert.deepEqual((await session.query("SHOW search_path", [])).rows, original);
            await assert.rejects(session.query("SAVEPOINT still_idle", []), {code: "25P01"});
            await session.query("BEGIN", []);
            await session.query("SET LOCAL search_path = pg_catalog", []);
            value(await inspectSchema(session, {schemas: ["public"], excluded: []}));
            assert.equal((await session.query("SHOW search_path", [])).rows[0]?.search_path, "pg_catalog");
            await session.query("COMMIT", []);
            assert.deepEqual((await session.query("SHOW search_path", [])).rows, original, "A pre-existing SET LOCAL must not become a session setting");
        } finally {
            try {await client.query("ROLLBACK");} finally {await client.end();}
        }
    });
});

integration("typed storage CHECK/index input round trip", () => {
    for (const generation of ["clean", "incremental"] as const) {
        it(`archives and enforces typed CHECK/index declarations after ${generation} creation`, async () => {
            await withScratchSchema(async (session, namespace) => {
                const metadata = {entities: {items: {
                    ...keyStorage(true).entities.items,
                    checks: {legacy_nonblank: {definition: "CHECK (char_length(slug) > 0)", columns: ["slug"]}},
                    // Recorded catalog SQL includes the resolved literal type; the descriptor preserves it.
                    indexes: {legacy_nonblank_idx: {definition: `CREATE INDEX legacy_nonblank_idx ON "${namespace}".items (slug) WHERE slug <> ''::text`}},
                }}};
                const system = value(decodeSqlSsot(keySnapshot, keyMapping, metadata, namespace));
                const state = value(await readStateBytes(jsonBytes(value(await captureMigrationState(system, namespace, "objects")))));
                const target = state.schema, empty = {...target, objects: []};
                const base = {from: {systemId: "objects", releaseId: "empty", releaseHash: "1".repeat(64)},
                    to: {systemId: "objects", releaseId: "objects", releaseHash: "2".repeat(64)},
                    fromSnapshotHash: "3".repeat(64), toSnapshotHash: "4".repeat(64), fromPersistenceHash: "5".repeat(64), toPersistenceHash: "6".repeat(64)};
                const statements = generation === "clean" ? value(generateCreate(target)).statements
                    : value(generateStructureSql(value(inferStructureChanges(base, empty, target, [])), empty, target));
                for (const statement of statements) await session.query(statement.text, []);
                assert.deepEqual(value(await assessSchema(state, namespace, session)), {equal: true, differences: []});
                await session.query(`INSERT INTO "${namespace}".parents (id) VALUES (1)`, []);
                await session.query(`INSERT INTO "${namespace}".items (id, "parentId", slug) VALUES (1, 1, 'valid')`, []);
                await session.query("SAVEPOINT expected_check_rejection", []);
                await assert.rejects(session.query(`INSERT INTO "${namespace}".items (id, "parentId", slug) VALUES (2, 1, '')`, []), error =>
                    typeof error === "object" && error !== null && "code" in error && error.code === "23514");
                await session.query("ROLLBACK TO SAVEPOINT expected_check_rejection", []);
                await session.query(`DROP INDEX "${namespace}".legacy_nonblank_idx`, []);
                const drift = value(await assessSchema(state, namespace, session));
                assert.equal(drift.equal, false);
                assert.ok(drift.differences.some(difference => difference.path.includes("legacy_nonblank_idx")));
            });
        });
    }
});

integration("typed storage preserves real constraint timing", () => {
    for (const generation of ["clean", "incremental"] as const) {
        it(`enforces named deferred FKs and deferrable uniqueness after ${generation} creation`, async () => {
            await withScratchSchema(async (session, namespace) => {
                const system = value(decodeSqlSsot(keySnapshot, keyMapping, keyStorage(true)));
                const state = value(await readStateBytes(jsonBytes(value(await captureMigrationState(system, namespace, "keys")))));
                const target = state.schema;
                const empty = {...target, objects: []};
                const base = {from: {systemId: "keys", releaseId: "empty", releaseHash: "1".repeat(64)},
                    to: {systemId: "keys", releaseId: "keys", releaseHash: "2".repeat(64)},
                    fromSnapshotHash: "3".repeat(64), toSnapshotHash: "4".repeat(64), fromPersistenceHash: "5".repeat(64), toPersistenceHash: "6".repeat(64)};
                const statements = generation === "clean" ? value(generateCreate(target)).statements
                    : value(generateStructureSql(value(inferStructureChanges(base, empty, target, [])), empty, target));
                for (const statement of statements) await session.query(statement.text, []);
                assert.deepEqual(value(await assessSchema(state, namespace, session)), {equal: true, differences: []});
                const items = `"${namespace}".items`, parents = `"${namespace}".parents`;
                // The FK permits inserting the child before its parent in this transaction.
                await session.query(`INSERT INTO ${items} (id, "parentId", slug) VALUES (1, 99, 'same')`, []);
                await session.query(`INSERT INTO ${parents} (id) VALUES (99)`, []);
                await session.query("SET CONSTRAINTS ALL IMMEDIATE", []);
                await session.query("SAVEPOINT expected_unique_rejection", []);
                await assert.rejects(session.query(`INSERT INTO ${items} (id, "parentId", slug) VALUES (2, 99, 'same')`, []), error =>
                    typeof error === "object" && error !== null && "code" in error && error.code === "23505");
                await session.query("ROLLBACK TO SAVEPOINT expected_unique_rejection", []);
                await session.query(`SET CONSTRAINTS "${namespace}".legacy_slug_key DEFERRED`, []);
                await session.query(`INSERT INTO ${items} (id, "parentId", slug) VALUES (2, 99, 'same')`, []);
                await session.query(`UPDATE ${items} SET slug = 'distinct' WHERE id = 2`, []);
                await session.query("SET CONSTRAINTS ALL IMMEDIATE", []);
                await session.query("SAVEPOINT expected_fk_rejection", []);
                await assert.rejects(session.query(`INSERT INTO ${items} (id, "parentId", slug) VALUES (3, 404, 'orphan')`, []), error =>
                    typeof error === "object" && error !== null && "code" in error && error.code === "23503");
                await session.query("ROLLBACK TO SAVEPOINT expected_fk_rejection", []);
                await session.query(`ALTER TABLE ${items} ALTER CONSTRAINT legacy_parent_fk NOT DEFERRABLE`, []);
                const drift = value(await assessSchema(state, namespace, session));
                assert.equal(drift.equal, false);
                assert.ok(drift.differences.some(difference => difference.path.includes("deferrable")));
            });
        });
    }
});

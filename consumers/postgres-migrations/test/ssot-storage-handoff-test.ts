import {strict as assert} from "node:assert";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe, it} from "mocha";
import {
    captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField,
    defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes,
    type SqlTypeMapping, type SystemSnapshotInfo, type ValidationResult,
} from "system-definition";
import {loadSsot} from "../src/ssot";
import {decodeSqlSsot, projectSsotSchema} from "../src/sql-mapping";
import {captureMigrationState, jsonBytes, readStateBytes, stateReference} from "../src/migration-store";
import type {PostgresColumnStorageDef, PostgresStorageDef} from "../src/postgres-storage";
import type {PgSession} from "../src/pg-schema";
import {generateCreate} from "../src/generate-create";
import {generateMigrationSql} from "../src/generate-migration";
import {inferStructureChanges} from "../src/infer";
import {assessSchema} from "../src/assessment";

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer", nullable: false}, slug: {type: "text", nullable: false}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
const snapshot = value(captureSystemSnapshot(context, {systemId: "storage-handoff", entities, records: context.records}));
const sqlMapping = {text: sqlTypes.varchar, integer: sqlTypes.bigint, boolean: sqlTypes.boolean} satisfies SqlTypeMapping<typeof snapshot>;

/** PostgreSQL-consumer metadata references the existing fields and primary key. */
const storage = (length: number) => ({entities: {items: {
    columns: {id: {identity: "byDefault"}, slug: {typeModifiers: [length]}},
    primaryKey: {name: "legacy_items_pk"},
}}} satisfies PostgresStorageDef<typeof snapshot>);

type IsAssignable<A, B> = [A] extends [B] ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type StorageShape = {entities: {readonly items?: {
    columns?: {readonly id?: PostgresColumnStorageDef; readonly slug?: PostgresColumnStorageDef};
    primaryKey?: {name: string} | null;
}}};
type PublicDef = PostgresStorageDef<typeof snapshot>;
type DefToShape = Expect<IsAssignable<PublicDef, StorageShape>>;
type ShapeToDef = Expect<IsAssignable<StorageShape, PublicDef>>;
type KnownFields = Expect<Equal<keyof NonNullable<NonNullable<PublicDef["entities"]["items"]>["columns"]>, "id" | "slug">>;
type UnknownEntity = Expect<Equal<IsAssignable<{entities: {missing: {primaryKey: {name: string}}}}, PublicDef>, false>>;
type UnknownColumn = Expect<Equal<IsAssignable<{entities: {items: {columns: {missing: {identity: "always"}}}}}, PublicDef>, false>>;
type UnknownIdentity = Expect<Equal<IsAssignable<{identity: "guessed"}, PostgresColumnStorageDef>, false>>;
type SqlInjection = Expect<Equal<IsAssignable<{typeModifiers: readonly string[]}, PostgresColumnStorageDef>, false>>;
const typeContracts: [DefToShape, ShapeToDef, KnownFields, UnknownEntity, UnknownColumn, UnknownIdentity, SqlInjection] = [true, true, true, true, true, true, true];

async function loadStorage(postgresStorage: unknown) {
    const root = await mkdtemp(join(tmpdir(), "sd-storage-handoff-"));
    try {
        const file = join(root, "system.mjs");
        await writeFile(file, `export const ssot = ${JSON.stringify(snapshot)};\nexport const sqlMapping = ${JSON.stringify(sqlMapping)};\nexport const postgresStorage = ${JSON.stringify(postgresStorage)};\n`);
        return await loadSsot(file);
    } finally {await rm(root, {recursive: true, force: true});}
}

describe("typed SSOT existing-storage handoff contract", () => {
    it("preserves the exact public entity/field keys and checks both directions of assignability", () => {
        assert.deepEqual(typeContracts, [true, true, true, true, true, true, true]);
    });
    it("preserves explicit column type parameters without changing the logical field type", async () => {
        const system = value(await loadStorage(storage(64)));
        const projected = value(projectSsotSchema(system, "app"));
        const column = projected.objects.find(object => object.kind === "column" && object.identity.name === "slug");
        assert.ok(column?.kind === "column");
        assert.equal(column.type.name, "varchar");
        assert.deepEqual(column.type.modifiers, ["64"]);
        assert.equal(system.ssot.entities.items?.fields.slug?.type, "text");
    });
    it("preserves the identity mode and existing primary-key name without redeclaring the key", async () => {
        const projected = value(projectSsotSchema(value(await loadStorage(storage(64))), "app"));
        const column = projected.objects.find(object => object.kind === "column" && object.identity.name === "id");
        assert.ok(column?.kind === "column");
        assert.equal(column.identityDefinition, "d");
        const key = projected.objects.find(object => object.kind === "constraint" && object.constraintKind === "primaryKey");
        assert.ok(key?.kind === "constraint");
        assert.equal(key.identity.name, "legacy_items_pk");
        assert.deepEqual(key.columns, ["id"]);
    });
    it("rejects unknown references and invalid physical attributes instead of ignoring metadata", async () => {
        const invalid = [
            {entities: {missing: {columns: {id: {identity: "byDefault"}}}}},
            {entities: {items: {columns: {missing: {identity: "byDefault"}}}}},
            {entities: {items: {columns: {id: {identity: "guessed"}}}}},
            {entities: {items: {columns: {slug: {typeModifiers: [-1]}}}}},
            {entities: {items: {columns: {slug: {typeModifiers: ["64); DROP TABLE items"]}}}}},
            {entities: {items: {columns: {slug: {nullable: true}}}}},
        ];
        for (const attributes of invalid) assert.equal((await loadStorage(attributes)).ok, false, JSON.stringify(attributes));
    });
    it("freezes physical metadata in migration state and includes it in the release hash", async () => {
        const before = value(await captureMigrationState(value(await loadStorage(storage(64))), "app", "baseline"));
        const after = value(await captureMigrationState(value(await loadStorage(storage(128))), "app", "baseline"));
        assert.notEqual(stateReference(before).releaseHash, stateReference(after).releaseHash);
        const restored = value(await readStateBytes(jsonBytes(after)));
        assert.deepEqual(restored, after);
        const column = restored.schema.objects.find(object => object.kind === "column" && object.identity.name === "slug");
        assert.ok(column?.kind === "column");
        assert.deepEqual(column.type.modifiers, ["128"]);
        const tampered = structuredClone(restored);
        const copiedColumn = tampered.schema.objects.find(object => object.kind === "column" && object.identity.name === "slug");
        assert.ok(copiedColumn?.kind === "column");
        copiedColumn.type.modifiers = ["256"];
        assert.equal((await readStateBytes(jsonBytes(tampered))).ok, false);
    });
    it("preserves pre-storage archived bytes and release hashes when metadata is absent", async () => {
        const legacy = value(await captureMigrationState(value(decodeSqlSsot(snapshot, sqlMapping)), "app", "baseline"));
        assert.equal(Object.hasOwn(legacy, "postgresStorage"), false);
        assert.equal(stateReference(legacy).releaseHash, "7cf3dd590204dc44625f8daafd3e54dfa03e6bd28849a7b708d63c47fbbcf456");
        const bytes = jsonBytes(legacy);
        assert.deepEqual(jsonBytes(value(await readStateBytes(bytes))), bytes);
    });
    it("validates parameters for their mapped SQL type and normalizes numeric's default scale", () => {
        const cases = [
            {type: sqlTypes.varchar, input: [10_485_760], expected: ["10485760"]},
            {type: sqlTypes.varchar, input: [], expected: []},
            {type: sqlTypes.numeric, input: [12], expected: ["12", "0"]},
            {type: sqlTypes.numeric, input: [12, -2], expected: ["12", "-2"]},
            {type: sqlTypes.numeric, input: [2, 4], expected: ["2", "4"]},
            {type: sqlTypes.time, input: [0], expected: ["0"]},
            {type: sqlTypes.timestampWithTimeZone, input: [6], expected: ["6"]},
        ];
        for (const {type, input, expected} of cases) {
            const system = value(decodeSqlSsot(snapshot, {...sqlMapping, text: type}, {entities: {items: {columns: {slug: {typeModifiers: input}}}}}));
            const column = value(projectSsotSchema(system, "app")).tables[0]?.columns.find(one => one.name === "slug");
            assert.deepEqual(column?.type.modifiers, expected);
        }
        for (const [type, input] of [
            [sqlTypes.varchar, [0]], [sqlTypes.varchar, [10_485_761]], [sqlTypes.varchar, [1.5]],
            [sqlTypes.numeric, [1001]], [sqlTypes.numeric, [12, -1001]], [sqlTypes.numeric, [1, 2, 3]],
            [sqlTypes.time, [7]], [sqlTypes.text, [64]], [sqlTypes.boolean, [1]],
        ] as const) {
            assert.equal(decodeSqlSsot(snapshot, {...sqlMapping, text: type}, {entities: {items: {columns: {slug: {typeModifiers: input}}}}}).ok, false);
        }
    });
    it("rejects truncated names, relation-name collisions and non-serializable metadata", async () => {
        for (const name of ["", "bad\0name", "x".repeat(64), "é".repeat(32), "items"]) {
            assert.equal((await loadStorage({entities: {items: {primaryKey: {name}}}})).ok, false, name);
        }
        for (const metadata of [null, {entities: {items: {extra: true}}}, {entities: {items: {columns: {slug: {typeModifiers: [NaN]}}}}}]) {
            assert.equal(decodeSqlSsot(snapshot, sqlMapping, metadata).ok, false);
        }
    });
    it("supports ALWAYS identities and rejects nullable or non-integer identities", () => {
        const system = value(decodeSqlSsot(snapshot, sqlMapping, {entities: {items: {columns: {id: {identity: "always"}}}}}));
        const column = value(projectSsotSchema(system, "app")).objects.find(object => object.kind === "column" && object.identity.name === "id");
        assert.ok(column?.kind === "column");
        assert.equal(column.identityDefinition, "a");
        assert.equal(decodeSqlSsot(snapshot, sqlMapping, {entities: {items: {columns: {slug: {identity: "always"}}}}}).ok, false);
        const nullable: SystemSnapshotInfo = structuredClone(snapshot);
        nullable.entities.items.fields.id.nullable = true;
        assert.equal(decodeSqlSsot(nullable, sqlMapping, {entities: {items: {columns: {id: {identity: "always"}}}}}).ok, false);
    });
    it("validates direct projection inputs and handles identifiers that match JavaScript properties", () => {
        const system = value(decodeSqlSsot(snapshot, sqlMapping));
        assert.equal(projectSsotSchema({...system, postgresStorage: {entities: {missing: {columns: {}, primaryKey: null}}}}, "app").ok, false);
        const constructorEntity = {...snapshot, entities: {constructor: {...snapshot.entities.items, name: "constructor"}}};
        const projected = value(projectSsotSchema(value(decodeSqlSsot(constructorEntity, sqlMapping, {entities: {}})), "app"));
        assert.equal(projected.tables[0]?.name, "constructor");
        assert.equal(projected.tables[0]?.primaryKey.name, "constructor_pkey");
    });
});

const connectionString = process.env.POSTGRES_HANDOFF_TEST_URL;
(connectionString ? describe : describe.skip)("typed storage against real PostgreSQL", () => {
    it("creates from reloaded state, enforces bounds, and widens a populated column without losing rows", async () => {
        const client = new Client({connectionString});
        const namespace = "handoff_storage_" + randomUUID().replaceAll("-", "");
        await client.connect();
        const session: PgSession = {async query(text, parameters) {
            const result = await client.query<Record<string, unknown>>(text, [...parameters]);
            return {rows: result.rows, rowCount: result.rowCount};
        }, async close() {throw new Error("The fixture owns the connection");}};
        try {
            await client.query("BEGIN");
            await client.query("SET LOCAL statement_timeout = '10s'");
            await client.query(`CREATE SCHEMA "${namespace}"`);
            const system = value(await loadStorage(storage(64)));
            const before = value(await readStateBytes(jsonBytes(value(await captureMigrationState(system, namespace, "before")))));
            for (const statement of value(generateCreate(before.schema)).statements) await client.query(statement.text);
            assert.deepEqual(value(await assessSchema(before, namespace, session)), {equal: true, differences: []});
            const first = await client.query(`INSERT INTO "${namespace}".items (slug) VALUES ($1) RETURNING id`, ["a".repeat(64)]);
            assert.equal(String(first.rows[0]?.id), "1");
            await client.query("SAVEPOINT expected_bound_rejection");
            await assert.rejects(client.query(`INSERT INTO "${namespace}".items (slug) VALUES ($1)`, ["b".repeat(65)]), error =>
                typeof error === "object" && error !== null && "code" in error && error.code === "22001");
            await client.query("ROLLBACK TO SAVEPOINT expected_bound_rejection");
            const target = value(await loadStorage(storage(128)));
            const after = value(await captureMigrationState(target, namespace, "after"));
            const base = {from: stateReference(before), to: stateReference(after), fromSnapshotHash: "1".repeat(64), toSnapshotHash: "2".repeat(64),
                fromPersistenceHash: "3".repeat(64), toPersistenceHash: "4".repeat(64)};
            const changes = value(inferStructureChanges(base, before.schema, after.schema, []));
            assert.equal(changes.length, 1);
            assert.equal(changes[0]?.impact, "requiresDataCheck");
            for (const statement of value(generateMigrationSql(changes, before.schema, target, namespace))) await client.query(statement.text);
            assert.deepEqual(value(await assessSchema(after, namespace, session)), {equal: true, differences: []});
            const original = await client.query(`SELECT slug FROM "${namespace}".items WHERE id = 1`);
            assert.deepEqual(original.rows, [{slug: "a".repeat(64)}]);
            await client.query(`INSERT INTO "${namespace}".items (slug) VALUES ($1)`, ["b".repeat(128)]);
        } finally {try {await client.query("ROLLBACK");} finally {await client.end();}}
    });
});

import {strict as assert} from "node:assert";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {
    captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField,
    defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes,
    type SqlTypeMapping, type ValidationResult,
} from "system-definition";
import {loadSsot} from "../src/ssot";
import {projectSsotSchema} from "../src/sql-mapping";
import {captureMigrationState, jsonBytes, readStateBytes, stateReference} from "../src/migration-store";

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer", nullable: false}, slug: {type: "text", nullable: false}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
const snapshot = value(captureSystemSnapshot(context, {systemId: "storage-handoff", entities, records: context.records}));
const sqlMapping = {text: sqlTypes.varchar, integer: sqlTypes.bigint, boolean: sqlTypes.boolean} satisfies SqlTypeMapping<typeof snapshot>;

/** Proposed optional PostgreSQL-consumer metadata; no duplicate fields, keys or nullability. */
const storage = (length: number) => ({entities: {items: {
    columns: {id: {identity: "byDefault"}, slug: {typeModifiers: [length]}},
    primaryKey: {name: "legacy_items_pk"},
}}});

async function loadStorage(postgresStorage: unknown) {
    const root = await mkdtemp(join(tmpdir(), "sd-storage-handoff-"));
    try {
        const file = join(root, "system.mjs");
        await writeFile(file, `export const ssot = ${JSON.stringify(snapshot)};\nexport const sqlMapping = ${JSON.stringify(sqlMapping)};\nexport const postgresStorage = ${JSON.stringify(postgresStorage)};\n`);
        return await loadSsot(file);
    } finally {await rm(root, {recursive: true, force: true});}
}

describe("typed SSOT existing-storage handoff contract", () => {
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
});

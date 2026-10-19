import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField,
    defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes,
    type ValidationResult,
} from "system-definition";
import {decodeSqlSsot, projectSsotSchema} from "../src/sql-mapping";
import {captureMigrationState, jsonBytes, readStateBytes, stateReference} from "../src/migration-store";
import {generateCreate} from "../src/generate-create";

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {
    parent: defineRecord(types, {id: {type: "integer", nullable: false}}),
    item: defineRecord(types, {id: {type: "integer", nullable: false}, parentId: {type: "integer", nullable: false}, slug: {type: "text", nullable: false}}),
});
const entities = defineEntities({
    parents: defineEntity(context, {name: "parents", record: "parent", pk: ["id"], fks: {}, uks: {}, validators: []}),
    items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {parent: {entity: "parents", fields: {parentId: "id"}}}, uks: {slug: ["slug"]}, validators: []}),
});
function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
const snapshot = value(captureSystemSnapshot(context, {systemId: "key-storage", entities, records: context.records}));
const mapping = {text: sqlTypes.text, integer: sqlTypes.bigint, boolean: sqlTypes.boolean};
const storage = (initiallyDeferred: boolean) => ({entities: {items: {
    foreignKeys: {parent: {name: "legacy_parent_fk", deferrable: true, initiallyDeferred}},
    uniqueKeys: {slug: {name: "legacy_slug_key", deferrable: true, initiallyDeferred: false}},
}}});

describe("typed storage preserves existing key names and timing", () => {
    it("preserves a named initially deferred FK while deriving its target and column pairs from the SSOT", () => {
        const schema = value(projectSsotSchema(value(decodeSqlSsot(snapshot, mapping, {entities: {items: {foreignKeys: storage(true).entities.items.foreignKeys}}})), "app"));
        const fk = schema.objects.find(object => object.kind === "constraint" && object.constraintKind === "foreignKey");
        assert.ok(fk?.kind === "constraint");
        assert.equal(fk.identity.name, "legacy_parent_fk");
        assert.equal(fk.deferrable, true);
        assert.equal(fk.initiallyDeferred, true);
        assert.equal(fk.target?.name, "parents");
        assert.deepEqual(fk.pairs, [{source: "parentId", target: "id"}]);
        const sql = value(generateCreate(schema)).statements.find(statement => statement.phase === "foreign-key")?.text;
        assert.match(sql ?? "", /CONSTRAINT "legacy_parent_fk".*REFERENCES "app"\."parents" \("id"\) DEFERRABLE INITIALLY DEFERRED/);
        assert.equal(schema.tables.find(table => table.name === "items")?.foreignKeys[0]?.name, "legacy_parent_fk");
    });
    it("preserves a named deferrable unique key while deriving its columns from the SSOT", () => {
        const schema = value(projectSsotSchema(value(decodeSqlSsot(snapshot, mapping, {entities: {items: {uniqueKeys: storage(true).entities.items.uniqueKeys}}})), "app"));
        const key = schema.objects.find(object => object.kind === "constraint" && object.constraintKind === "unique");
        assert.ok(key?.kind === "constraint");
        assert.equal(key.identity.name, "legacy_slug_key");
        assert.deepEqual(key.columns, ["slug"]);
        assert.equal(key.deferrable, true);
        assert.equal(key.initiallyDeferred, false);
        assert.ok(value(generateCreate(schema)).statements.some(statement => /CONSTRAINT "legacy_slug_key" UNIQUE \("slug"\) DEFERRABLE INITIALLY IMMEDIATE/.test(statement.text)));
        assert.equal(schema.tables.find(table => table.name === "items")?.uniqueKeys[0]?.name, "legacy_slug_key");
    });
    it("validates supported metadata and rejects unknown keys, contradictory timing, collisions and duplicate relationship declarations", () => {
        assert.equal(decodeSqlSsot(snapshot, mapping, storage(true)).ok, true);
        for (const attrs of [
            {foreignKeys: {missing: {name: "missing_fk"}}},
            {uniqueKeys: {missing: {name: "missing_key"}}},
            {foreignKeys: {parent: {deferrable: false, initiallyDeferred: true}}},
            {foreignKeys: {parent: {deferrable: "true"}}},
            {foreignKeys: {parent: {name: "items_pkey"}}},
            {uniqueKeys: {slug: {name: "parents_pkey"}}},
            {foreignKeys: {parent: {fields: {parentId: "id"}}}},
            {uniqueKeys: {slug: {columns: ["slug"]}}},
        ]) assert.equal(decodeSqlSsot(snapshot, mapping, {entities: {items: attrs}}).ok, false, JSON.stringify(attrs));
    });
    it("includes key timing in archived state and hashes without changing the domain snapshot or generic mapping", async () => {
        const before = value(await captureMigrationState(value(decodeSqlSsot(snapshot, mapping, storage(true))), "app", "baseline"));
        const after = value(await captureMigrationState(value(decodeSqlSsot(snapshot, mapping, storage(false))), "app", "baseline"));
        assert.deepEqual(before.ssot, after.ssot);
        assert.deepEqual(before.persistence, after.persistence);
        assert.notEqual(stateReference(before).releaseHash, stateReference(after).releaseHash);
        const restored = value(await readStateBytes(jsonBytes(after)));
        assert.deepEqual(restored, after);
        const fk = restored.schema.objects.find(object => object.kind === "constraint" && object.constraintKind === "foreignKey");
        assert.ok(fk?.kind === "constraint");
        assert.equal(fk.deferrable, true);
        assert.equal(fk.initiallyDeferred, false);
    });
});

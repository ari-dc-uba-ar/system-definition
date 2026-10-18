import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField,
    defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes,
    type ValidationResult} from "system-definition";
import {captureMigrationState, jsonBytes, readStateBytes} from "../src/migration-store";
import {decodeSqlSsot} from "../src/sql-mapping";

function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {
    parent: defineRecord(types, {z_id: {type: "integer"}, a_id: {type: "integer"}}),
    child: defineRecord(types, {id: {type: "integer"}, z_parent: {type: "integer"}, a_parent: {type: "integer"}}),
});
const entities = defineEntities({
    parents: defineEntity(context, {name: "parents", record: "parent", pk: ["z_id", "a_id"], fks: {}, uks: {}, validators: []}),
    children: defineEntity(context, {name: "children", record: "child", pk: ["id"],
        fks: {parent: {entity: "parents", fields: {z_parent: "a_id", a_parent: "z_id"}}}, uks: {}, validators: []}),
});
const snapshot = value(captureSystemSnapshot(context, {systemId: "composite-fk", entities}));
const mapping = {text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean};

describe("Saved migration state with composite foreign keys", () => {
    it("roundtrips aliased FK pairs through canonical JSON without a checksum mismatch", async () => {
        const system = value(decodeSqlSsot(snapshot, mapping));
        const state = value(await captureMigrationState(system, "app", "initial"));
        const bytes = jsonBytes(state);
        assert.deepEqual(value(await readStateBytes(bytes)), state);
        assert.deepEqual(jsonBytes(value(await readStateBytes(bytes))), bytes);
    });

    it("projects the same FK for either mapping insertion order and preserves each pair", async () => {
        const system = value(decodeSqlSsot(snapshot, mapping));
        const reordered = structuredClone(snapshot);
        reordered.entities.children.fks.parent.fields = {a_parent: "z_id", z_parent: "a_id"};
        const first = value(await captureMigrationState(system, "app", "initial"));
        const second = value(await captureMigrationState(value(decodeSqlSsot(reordered, mapping)), "app", "initial"));
        assert.deepEqual(first.schema, second.schema);
        assert.deepEqual(jsonBytes(first), jsonBytes(second));
        const fk = first.schema.objects.find(object => object.kind === "constraint" && object.constraintKind === "foreignKey");
        assert.ok(fk && fk.kind === "constraint");
        assert.deepEqual(fk.pairs, [
            {source: "a_parent", target: "z_id"},
            {source: "z_parent", target: "a_id"},
        ]);
        assert.deepEqual(fk.columns, ["a_parent", "z_parent"]);
        assert.equal(fk.definition, 'FOREIGN KEY ("a_parent", "z_parent") REFERENCES "app"."parents" ("z_id", "a_id")');
        assert.deepEqual(first.ssot.entities.parents.pk, ["z_id", "a_id"]);
    });
});

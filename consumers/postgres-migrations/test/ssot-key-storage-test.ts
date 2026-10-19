import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import {decodeSqlSsot, projectSsotSchema} from "../src/sql-mapping";
import {captureMigrationState, jsonBytes, readStateBytes, stateReference} from "../src/migration-store";
import {generateCreate} from "../src/generate-create";
import type {PostgresKeyStorageDef, PostgresStorageDef} from "../src/postgres-storage";
import {snapshot, mapping, storage} from "./fixtures/key-storage-fixture";

function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type Expect<T extends true> = T;
type Def = NonNullable<PostgresStorageDef<typeof snapshot>["entities"]["items"]>;
type KeyShape = {name?: string | null; deferrable?: boolean; initiallyDeferred?: boolean};
type KeyToShape = Expect<IsAssignable<PostgresKeyStorageDef, KeyShape>>;
type ShapeToKey = Expect<IsAssignable<KeyShape, PostgresKeyStorageDef>>;
type FkNames = Expect<Equal<keyof NonNullable<Def["foreignKeys"]>, "parent">>;
type UkNames = Expect<Equal<keyof NonNullable<Def["uniqueKeys"]>, "slug">>;
type UnknownFk = Expect<Equal<IsAssignable<{missing: {name: string}}, NonNullable<Def["foreignKeys"]>>, false>>;
type UnknownUk = Expect<Equal<IsAssignable<{missing: {name: string}}, NonNullable<Def["uniqueKeys"]>>, false>>;
type NoFks = Expect<Equal<IsAssignable<{foreignKeys: {missing: {name: string}}}, NonNullable<PostgresStorageDef<typeof snapshot>["entities"]["parents"]>>, false>>;
type InvalidTiming = Expect<Equal<IsAssignable<{deferrable: string}, PostgresKeyStorageDef>, false>>;
const contracts: [KeyToShape, ShapeToKey, FkNames, UkNames, UnknownFk, UnknownUk, NoFks, InvalidTiming] = [true, true, true, true, true, true, true, true];

describe("typed storage preserves existing key names and timing", () => {
    it("types only the existing logical keys and reuses constraint timing attributes", () => {
        assert.deepEqual(contracts, [true, true, true, true, true, true, true, true]);
    });
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
    it("retains generated names and non-deferrable defaults for omitted attributes", () => {
        const system = value(decodeSqlSsot(snapshot, mapping, {entities: {items: {foreignKeys: {parent: {}}, uniqueKeys: {slug: {}}}}}));
        const schema = value(projectSsotSchema(system, "app"));
        const fk = schema.objects.find(object => object.kind === "constraint" && object.constraintKind === "foreignKey");
        assert.ok(fk?.kind === "constraint");
        assert.equal(fk.identity.name, "items_parent_fkey");
        assert.equal(fk.deferrable, false);
        assert.equal(fk.initiallyDeferred, false);
        const key = schema.objects.find(object => object.kind === "constraint" && object.constraintKind === "unique");
        assert.ok(key?.kind === "constraint");
        assert.equal(key.identity.name, "items_slug_key");
        assert.equal(key.deferrable, false);
    });
});

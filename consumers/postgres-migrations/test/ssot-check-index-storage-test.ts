import {strict as assert} from "node:assert";
import type {ValidationResult} from "system-definition";
import {decodeSqlSsot, projectSsotSchema} from "../src/sql-mapping";
import {captureMigrationState, jsonBytes, readStateBytes, stateReference} from "../src/migration-store";
import {generateCreate} from "../src/generate-create";
import {snapshot, mapping, storage} from "./fixtures/key-storage-fixture";

function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}

const metadata = (condition = "char_length(slug) > 0", predicate = "slug <> ''") => ({entities: {items: {
    ...storage(true).entities.items,
    checks: {legacy_nonblank: {definition: `CHECK (${condition})`, columns: ["slug"]}},
    indexes: {legacy_nonblank_idx: {definition: `CREATE INDEX legacy_nonblank_idx ON public.items USING btree (slug) WHERE ${predicate}`}},
}}});

describe("typed storage wires existing CHECK/index vocabulary into authoring", () => {
    it("projects recorded CHECK/index definitions with identities derived from the containing entity", () => {
        const projected = value(projectSsotSchema(value(decodeSqlSsot(snapshot, mapping, metadata())), "public"));
        const check = projected.objects.find(object => object.kind === "constraint" && object.constraintKind === "check");
        assert.ok(check?.kind === "constraint");
        assert.equal(check.identity.name, "legacy_nonblank");
        assert.equal(check.identity.parentName, "items");
        assert.deepEqual(check.columns, ["slug"]);
        assert.equal(check.validated, true);
        assert.equal(check.enforced, true);
        const index = projected.objects.find(object => object.kind === "index");
        assert.ok(index?.kind === "index");
        assert.equal(index.identity.name, "legacy_nonblank_idx");
        assert.equal(index.identity.parentName, "items");
        assert.equal(index.valid, true);
        assert.equal(index.ready, true);
        assert.equal(index.ownerConstraint, null);
    });

    it("reuses existing generation for the projected CHECK and independent partial index", () => {
        const projected = value(projectSsotSchema(value(decodeSqlSsot(snapshot, mapping, metadata())), "public"));
        const sql = value(generateCreate(projected)).statements.map(statement => statement.text).join("\n");
        assert.match(sql, /legacy_nonblank.*CHECK/s);
        assert.match(sql, /legacy_nonblank_idx.*WHERE/s);
    });

    it("preserves descriptions through saved state and includes changes in release hashes", async () => {
        const original = value(await captureMigrationState(value(decodeSqlSsot(snapshot, mapping, metadata())), "public", "objects"));
        assert.deepEqual(value(await readStateBytes(jsonBytes(original))), original);
        for (const changed of [metadata("char_length(slug) >= 0"), metadata(undefined, "slug <> 'changed'")]) {
            const state = value(await captureMigrationState(value(decodeSqlSsot(snapshot, mapping, changed)), "public", "objects"));
            assert.notEqual(stateReference(state).releaseHash, stateReference(original).releaseHash);
        }
    });

    it("rejects invalid references, conflicting names and SQL bound to a different object", () => {
        value(decodeSqlSsot(snapshot, mapping, metadata()));
        const good = metadata().entities.items;
        const invalid = [
            {...good, checks: {legacy_nonblank: {definition: "CHECK (char_length(slug) > 0)", columns: ["missing"]}}},
            {...good, checks: {items_pkey: {definition: "CHECK (char_length(slug) > 0)", columns: ["slug"]}}},
            {...good, indexes: {items: {definition: "CREATE INDEX items ON public.items (slug)"}}},
            {...good, indexes: {legacy_nonblank_idx: {definition: "CREATE INDEX wrong_name ON public.items (slug)"}}},
            {...good, indexes: {legacy_nonblank_idx: {definition: "CREATE INDEX legacy_nonblank_idx ON public.parents (id)"}}},
            {...good, indexes: {legacy_nonblank_idx: {definition: "CREATE INDEX legacy_nonblank_idx ON public.items (slug); DROP TABLE public.parents"}}},
        ];
        for (const entity of invalid) assert.equal(decodeSqlSsot(snapshot, mapping, {entities: {items: entity}}).ok, false);
    });
});

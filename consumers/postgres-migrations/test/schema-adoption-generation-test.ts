import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {generateCreate} from "../src/generate-create";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";
import {normalizePgSchema} from "../src/normalize-schema";
import {compareSchemas} from "../src/compare-schema";

const table: PgObjectInfo = {
    kind: "table",
    identity: {schema: "app", kind: "table", name: "items", parentName: null, signature: []},
    persistence: "permanent", relationKind: "r",
};

function column(name: string, type: string): Extract<PgObjectInfo, {kind: "column"}> {
    return {
        kind: "column",
        identity: {schema: "app", kind: "column", name, parentName: "items", signature: []},
        type: {schema: "pg_catalog", name: type, modifiers: [], arrayDimensions: 0, collation: null},
        nullable: false, defaultExpression: null, identityDefinition: null, generatedDefinition: null,
    };
}

function schema(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: [table, ...objects]};
}

function statements(target: PgSchemaInfo): string {
    const result = generateCreate(target);
    assert.equal(result.ok, true, `The recorded schema must be reproducible: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error("Generation must succeed");
    return result.value.statements.map(statement => statement.text).join("\n");
}

describe("existing-schema handoff: reproduce preserved database invariants", () => {
    for (const [definition, keyword] of [["d", "BY DEFAULT"], ["a", "ALWAYS"]] as const) {
        it(`recreates an existing GENERATED ${keyword} identity column`, () => {
            const id = {...column("id", "int8"), identityDefinition: definition};
            assert.ok(statements(schema([id])).includes(`GENERATED ${keyword} AS IDENTITY`));
        });
    }

    it("recreates a named validated CHECK with its recorded definition", () => {
        const check: PgObjectInfo = {
            kind: "constraint",
            identity: {schema: "app", kind: "constraint", name: "legacy_nonnegative", parentName: "items", signature: []},
            constraintKind: "check", definition: "CHECK (counter >= 0)", columns: ["counter"],
            target: null, pairs: [], deferrable: false, initiallyDeferred: false, validated: true, enforced: true,
        };
        const sql = statements(schema([column("counter", "int4"), check]));
        assert.match(sql, /CONSTRAINT "legacy_nonnegative" CHECK \(counter >= 0\)/);
    });

    it("recreates an independent partial unique index with its original name and predicate", () => {
        const index: PgObjectInfo = {
            kind: "index",
            identity: {schema: "app", kind: "index", name: "legacy_active_slug", parentName: "items", signature: []},
            definition: 'CREATE UNIQUE INDEX legacy_active_slug ON app.items USING btree (slug) WHERE active',
            valid: true, ready: true, ownerConstraint: null,
        };
        const sql = statements(schema([column("slug", "text"), column("active", "bool"), index]));
        assert.match(sql, /CREATE UNIQUE INDEX "legacy_active_slug" ON "app"\."items" USING btree \(slug\) WHERE active/);
    });

    it("rejects unsupported identity combinations without emitting incomplete SQL", () => {
        const id = {...column("id", "int8"), identityDefinition: "d"};
        for (const invalid of [
            {...id, identityDefinition: "unknown"}, {...id, nullable: true},
            {...id, defaultExpression: "1"}, {...id, generatedDefinition: "id + 1"},
            {...id, type: {...id.type, name: "text"}}, {...id, type: {...id.type, arrayDimensions: 1}},
        ]) assert.equal(generateCreate(schema([invalid])).ok, false);
    });

    it("rejects CHECK definitions containing another statement or ALTER action", () => {
        for (const definition of [
            "CHECK (counter >= 0); DROP TABLE app.items", "CHECK (counter >= 0), DROP COLUMN counter",
            "UNIQUE (counter)", "CHECK (counter >= 0) NOT VALID",
            'ALTER TABLE app.other ADD CONSTRAINT legacy_nonnegative CHECK (counter >= 0)',
        ]) {
            const check: PgObjectInfo = {
                kind: "constraint",
                identity: {schema: "app", kind: "constraint", name: "legacy_nonnegative", parentName: "items", signature: []},
                constraintKind: "check", definition, columns: ["counter"], target: null, pairs: [],
                deferrable: false, initiallyDeferred: false, validated: true, enforced: true,
            };
            assert.equal(generateCreate(schema([column("counter", "int4"), check])).ok, false);
        }
    });

    it("binds index definitions to their recorded identity and rejects extra statements", () => {
        for (const definition of [
            "CREATE INDEX wrong ON app.items (slug)", "CREATE INDEX legacy_active_slug ON app.other (slug)",
            "CREATE INDEX legacy_active_slug ON other.items (slug)",
            "CREATE INDEX legacy_active_slug ON app.items (slug); DROP TABLE app.items",
            "CREATE INDEX CONCURRENTLY legacy_active_slug ON app.items (slug)",
            "CREATE INDEX IF NOT EXISTS legacy_active_slug ON app.items (slug)",
        ]) {
            const index: PgObjectInfo = {
                kind: "index",
                identity: {schema: "app", kind: "index", name: "legacy_active_slug", parentName: "items", signature: []},
                definition, valid: true, ready: true, ownerConstraint: null,
            };
            assert.equal(generateCreate(schema([column("slug", "text"), index])).ok, false);
        }
    });

    it("preserves punctuation inside quoted identifiers and CHECK string literals", () => {
        const check: PgObjectInfo = {
            kind: "constraint",
            identity: {schema: "app", kind: "constraint", name: 'check"name', parentName: "items", signature: []},
            constraintKind: "check", definition: "CHECK (slug <> '); DROP TABLE app.items;')", columns: ["slug"],
            target: null, pairs: [], deferrable: false, initiallyDeferred: false, validated: true, enforced: true,
        };
        const index: PgObjectInfo = {
            kind: "index",
            identity: {schema: "app", kind: "index", name: 'index"name', parentName: "items", signature: []},
            definition: 'CREATE INDEX "index""name" ON "app"."items" USING btree (slug)',
            valid: true, ready: true, ownerConstraint: null,
        };
        const sql = statements(schema([column("slug", "text"), check, index]));
        assert.ok(sql.includes('CONSTRAINT "check""name" CHECK'));
        assert.ok(sql.includes('CREATE INDEX "index""name"'));
    });

    it("qualifies an unqualified catalog index parent using its recorded schema", () => {
        const index: PgObjectInfo = {
            kind: "index",
            identity: {schema: "app", kind: "index", name: "legacy_slug", parentName: "items", signature: []},
            definition: "CREATE INDEX legacy_slug ON items USING btree (slug)",
            valid: true, ready: true, ownerConstraint: null,
        };
        assert.ok(statements(schema([column("slug", "text"), index])).includes('ON "app"."items" USING btree (slug)'));
    });

    it("normalizes equivalent catalog string-array casts while retaining changed predicates", async () => {
        const index: Extract<PgObjectInfo, {kind: "index"}> = {
            kind: "index",
            identity: {schema: "app", kind: "index", name: "legacy_slug", parentName: "items", signature: []},
            definition: "CREATE INDEX legacy_slug ON app.items (slug) WHERE slug::text = ANY (ARRAY['A'::varchar]::text[])",
            valid: true, ready: true, ownerConstraint: null,
        };
        const replayed = {...index, definition: "CREATE INDEX legacy_slug ON app.items (slug) WHERE slug::text = ANY (ARRAY['A'::varchar::text])"};
        const expected = await normalizePgSchema(schema([column("slug", "text"), index]));
        const actual = await normalizePgSchema(schema([column("slug", "text"), replayed]));
        const compared = compareSchemas(expected, {schema: actual, unknown: [], excluded: []});
        assert.ok(compared.ok);
        assert.equal(compared.value.equal, true);
        assert.deepEqual(await normalizePgSchema(expected), expected);
        const changed = await normalizePgSchema(schema([column("slug", "text"), {...replayed, definition: replayed.definition.replace("'A'", "'B'")} ]));
        const drift = compareSchemas(expected, {schema: changed, unknown: [], excluded: []});
        assert.ok(drift.ok);
        assert.equal(drift.value.equal, false);
    });
});

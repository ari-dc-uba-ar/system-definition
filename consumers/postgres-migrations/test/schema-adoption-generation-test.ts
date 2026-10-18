import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {generateCreate} from "../src/generate-create";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

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
        assert.match(sql, /CREATE UNIQUE INDEX legacy_active_slug ON app\.items USING btree \(slug\) WHERE active/);
    });
});

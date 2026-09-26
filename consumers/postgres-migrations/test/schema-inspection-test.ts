import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {PgObjectIdentity, PgObjectInfo, PgSchemaInfo, PgSession, SqlParameter} from "../src/pg-schema";
import {inspectSchema} from "../src/inspect-schema";
import {compareSchemas} from "../src/compare-schema";

type CatalogRow = Readonly<Record<string, unknown>>;

type Scope = {
    schemas: readonly string[];
    excluded: readonly {object: PgObjectIdentity; reason: string}[];
};

const excludedIndex: PgObjectIdentity = {
    schema: "app",
    kind: "index",
    name: "child_status_idx",
    parentName: "child",
    signature: [],
};

const scope: Scope = {
    schemas: ["app"],
    excluded: [{object: excludedIndex, reason: "managed by an external extension"}],
};

const catalogRows: readonly CatalogRow[] = [
    {
        object_kind: "table",
        schema_name: "app",
        object_name: "parent",
        parent_name: null,
        signature: [],
        persistence: "p",
        relation_kind: "r",
        oid: 91001,
    },
    {
        object_kind: "column",
        schema_name: "app",
        object_name: "id",
        parent_name: "parent",
        signature: [],
        type_schema: "pg_catalog",
        type_name: "int4",
        type_modifiers: [],
        array_dimensions: 0,
        collation: null,
        nullable: false,
        default_expression: null,
        identity_definition: null,
        generated_definition: null,
        oid: 91002,
    },
    {
        object_kind: "table",
        schema_name: "app",
        object_name: "child",
        parent_name: null,
        signature: [],
        persistence: "p",
        relation_kind: "r",
        oid: 92001,
    },
    {
        object_kind: "column",
        schema_name: "app",
        object_name: "id",
        parent_name: "child",
        signature: [],
        type_schema: "pg_catalog",
        type_name: "int4",
        type_modifiers: [],
        array_dimensions: 0,
        collation: null,
        nullable: false,
        default_expression: null,
        identity_definition: null,
        generated_definition: null,
        oid: 92002,
    },
    {
        object_kind: "column",
        schema_name: "app",
        object_name: "parent_id",
        parent_name: "child",
        signature: [],
        type_schema: "pg_catalog",
        type_name: "int4",
        type_modifiers: [],
        array_dimensions: 0,
        collation: null,
        nullable: false,
        default_expression: null,
        identity_definition: null,
        generated_definition: null,
        oid: 92003,
    },
    {
        object_kind: "column",
        schema_name: "app",
        object_name: "status",
        parent_name: "child",
        signature: [],
        type_schema: "pg_catalog",
        type_name: "text",
        type_modifiers: [],
        array_dimensions: 0,
        collation: null,
        nullable: true,
        default_expression: "'new'::text",
        identity_definition: null,
        generated_definition: null,
        oid: 92004,
    },
    {
        object_kind: "constraint",
        schema_name: "app",
        object_name: "child_parent_fkey",
        parent_name: "child",
        signature: [],
        constraint_kind: "foreignKey",
        definition: "FOREIGN KEY (parent_id) REFERENCES app.parent(id) ON DELETE CASCADE",
        columns: ["parent_id"],
        target_schema: "app",
        target_name: "parent",
        pairs: [{source: "parent_id", target: "id"}],
        deferrable: false,
        initially_deferred: false,
        validated: true,
        enforced: true,
        oid: 92005,
    },
    {
        object_kind: "index",
        schema_name: "app",
        object_name: "child_status_idx",
        parent_name: "child",
        signature: [],
        definition: "CREATE INDEX child_status_idx ON app.child USING btree (status)",
        valid: true,
        ready: true,
        owner_constraint_schema: null,
        owner_constraint_name: null,
        owner_constraint_parent: null,
        oid: 92006,
    },
];

function sessionWithRows(baseRows: readonly CatalogRow[], includeUnknown = false): PgSession {
    let pending = false;
    return {
        async query(text: string, values: readonly SqlParameter[]) {
            if (/^BEGIN$/i.test(text.trim())) return {rows: [], rowCount: null};
            if (/^ROLLBACK$/i.test(text.trim())) return {rows: [], rowCount: null};
            if (/^CREATE TABLE\s+"app"\."pending"/i.test(text.trim())) {
                pending = true;
                return {rows: [], rowCount: null};
            }
            assert.match(text, /pg_catalog/i);
            assert.ok(values.includes("app"));
            const rows: CatalogRow[] = baseRows.map(one => ({...one}));
            if (pending) {
                rows.push({
                    object_kind: "table",
                    schema_name: "app",
                    object_name: "pending",
                    parent_name: null,
                    signature: [],
                    persistence: "p",
                    relation_kind: "r",
                    oid: 99991,
                });
            }
            if (includeUnknown) {
                rows.push({
                    object_kind: "trigger",
                    schema_name: "app",
                    object_name: "child_touch",
                    parent_name: "child",
                    signature: [],
                    feature: "trigger",
                    oid: 99992,
                });
            }
            return {rows, rowCount: rows.length};
        },
        async close() {},
    };
}

function firstProblemKey(result: {ok: boolean; problems?: readonly {messageKey: string}[]}): string | undefined {
    return result.ok ? undefined : result.problems?.[0]?.messageKey;
}

function schemaWithObjects(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects};
}

describe("PostgreSQL schema inspection and semantic comparison", () => {
    it("inspects through the supplied session, so uncommitted DDL in that session is visible", async () => {
        const session = sessionWithRows([]);
        await session.query("BEGIN", []);
        await session.query('CREATE TABLE "app"."pending" ("id" integer)', []);

        const inspected = await inspectSchema(session, {schemas: ["app"], excluded: []});
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;
        assert.ok(inspected.value.schema.objects.some((one: PgObjectInfo) => one.kind === "table" && one.identity.name === "pending"));

        await session.query("ROLLBACK", []);
    });

    it("normalizes inventory order, ignores catalog OIDs and reports exact exclusions", async () => {
        const forward = await inspectSchema(sessionWithRows(catalogRows), scope);
        const backward = await inspectSchema(sessionWithRows([...catalogRows].reverse().map(one => ({...one, oid: Number(one.oid) + 500000}))), scope);
        assert.equal(forward.ok, true);
        assert.equal(backward.ok, true);
        if (!forward.ok || !backward.ok) return;

        assert.deepEqual(forward.value.schema, backward.value.schema);
        assert.deepEqual(forward.value.excluded, [{object: excludedIndex, reason: "managed by an external extension"}]);
        assert.equal(forward.value.schema.objects.some((one: PgObjectInfo) => one.identity.name === "child_status_idx"), false);
    });

    it("preserves nullability, defaults and FK actions and reports semantic changes with paths", async () => {
        const inspected = await inspectSchema(sessionWithRows(catalogRows), scope);
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;

        const status = inspected.value.schema.objects.find((one: PgObjectInfo) => one.kind === "column" && one.identity.parentName === "child" && one.identity.name === "status");
        assert.ok(status && status.kind === "column");
        assert.equal(status.nullable, true);
        assert.equal(status.defaultExpression, "'new'::text");

        const fk = inspected.value.schema.objects.find((one: PgObjectInfo) => one.kind === "constraint" && one.identity.name === "child_parent_fkey");
        assert.ok(fk && fk.kind === "constraint");
        assert.match(fk.definition, /ON DELETE CASCADE/);

        const changedObjects = inspected.value.schema.objects.map((one: PgObjectInfo): PgObjectInfo => {
            if (one.kind === "column" && one.identity.parentName === "child" && one.identity.name === "status") {
                return {...one, nullable: false, defaultExpression: null};
            }
            if (one.kind === "constraint" && one.identity.name === "child_parent_fkey") {
                return {...one, definition: one.definition.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")};
            }
            return one;
        });
        const compared = compareSchemas(schemaWithObjects(changedObjects), inspected.value);
        assert.equal(compared.ok, true);
        if (!compared.ok) return;
        assert.equal(compared.value.equal, false);
        assert.ok(compared.value.differences.some((one: {path: readonly string[]}) => one.path.at(-1) === "nullable"));
        assert.ok(compared.value.differences.some((one: {path: readonly string[]}) => one.path.at(-1) === "defaultExpression"));
        assert.ok(compared.value.differences.some((one: {path: readonly string[]}) => one.path.at(-1) === "definition"));
    });

    it("treats creation order as irrelevant but still reports added objects", async () => {
        const inspected = await inspectSchema(sessionWithRows(catalogRows), scope);
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;

        const reordered = schemaWithObjects([...inspected.value.schema.objects].reverse());
        const same = compareSchemas(reordered, inspected.value);
        assert.equal(same.ok, true);
        if (!same.ok) return;
        assert.equal(same.value.equal, true);
        assert.deepEqual(same.value.differences, []);

        const extra: PgObjectInfo = {
            kind: "table",
            identity: {schema: "app", kind: "table", name: "unexpected", parentName: null, signature: []},
            persistence: "p",
            relationKind: "r",
        };
        const actualWithExtra = {
            ...inspected.value,
            schema: schemaWithObjects([...inspected.value.schema.objects, extra]),
        };
        const difference = compareSchemas(reordered, actualWithExtra);
        assert.equal(difference.ok, true);
        if (!difference.ok) return;
        assert.equal(difference.value.equal, false);
        assert.ok(difference.value.differences.some((one: {change: string}) => one.change === "add"));
    });

    it("keeps unsupported inventory visible and blocks comparison instead of ignoring it", async () => {
        const inspected = await inspectSchema(sessionWithRows(catalogRows, true), scope);
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;
        assert.equal(inspected.value.unknown.length, 1);
        assert.equal(inspected.value.unknown[0]?.feature, "trigger");

        const compared = compareSchemas(inspected.value.schema, inspected.value);
        assert.equal(compared.ok, false);
        assert.equal(firstProblemKey(compared), "migration.unsupportedSchemaFeature");
    });
});

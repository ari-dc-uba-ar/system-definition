import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ResourceRefInfo, SystemSnapshotInfo, ValidationResult} from "system-definition";
import type {PgSchemaInfo} from "../src/pg-schema";
import type {DataMigrationInfo, QueryRefInfo, TransformationInfo} from "../src/migration-authoring";
import {
    compileDataMigration,
    type CompileDataContext,
    type CompiledDataMigration,
    type RelationRewriteRequest,
    type RelationRewriter,
} from "../src/compile-data";

function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function query(name: string, text: string): QueryRefInfo {
    return {name, kind: "query", contentHash: hashText(text)};
}

const sourceSql = [
    'SELECT "p"."id" AS "id", "p"."left_value" AS "left_value", "p"."right_value" AS "right_value"',
    'FROM "app"."people" AS "p";',
    "",
].join("\n");

const transformationSql = [
    "SELECT i.__source_id, i.id, i.right_value AS left_after, i.left_value AS right_after",
    "FROM migration_input AS i;",
    "",
].join("\n");

const transformation: TransformationInfo = {
    name: "swap-values",
    version: "1",
    inputs: {
        id: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "people", field: "id"},
        },
        left_value: {
            domain: {side: "from", type: "text", nullable: true},
            field: {side: "from", entity: "people", field: "left_value"},
        },
        right_value: {
            domain: {side: "from", type: "text", nullable: true},
            field: {side: "from", entity: "people", field: "right_value"},
        },
    },
    parameters: {},
    outputs: {
        id: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "people", field: "id"},
        },
        left_after: {
            domain: {side: "to", type: "text", nullable: true},
            field: {side: "to", entity: "people", field: "left_value"},
        },
        right_after: {
            domain: {side: "to", type: "text", nullable: true},
            field: {side: "to", entity: "people", field: "right_value"},
        },
    },
    mode: "row",
    query: query("swap-values.sql", transformationSql),
    lineage: null,
    before: [],
    after: [],
};

const conservationCheck: ResourceRefInfo = {
    name: "swap-conserved",
    kind: "check",
    contentHash: "c".repeat(64),
};

const migration: DataMigrationInfo = {
    id: "swap-people-values",
    description: "",
    dependsOn: [],
    source: {
        query: query("swap-source.sql", sourceSql),
        ports: transformation.inputs,
        identity: ["id"],
        coverageChecks: [],
    },
    transformation: transformation.name,
    arguments: {},
    writes: [{
        kind: "update",
        entity: "people",
        values: [
            {output: "left_after", target: {side: "to", entity: "people", field: "left_value"}},
            {output: "right_after", target: {side: "to", entity: "people", field: "right_value"}},
        ],
        match: [{output: "id", targetField: "id"}],
        whenMissing: "error",
    }],
    conservationChecks: [conservationCheck],
};

const targetSnapshot: SystemSnapshotInfo = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["integer", "text"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                left_value: {name: "left_value", type: "text", nullable: true},
                right_value: {name: "right_value", type: "text", nullable: true},
                note: {name: "note", type: "text", nullable: true},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: [],
        },
    },
    records: {},
};

function column(name: string, nullable: boolean): PgSchemaInfo["objects"][number] {
    return {
        kind: "column",
        identity: {schema: "app", kind: "column", name, parentName: "people", signature: []},
        type: {
            schema: "pg_catalog",
            name: name === "id" ? "int4" : "text",
            modifiers: [],
            arrayDimensions: 0,
            collation: null,
        },
        nullable,
        defaultExpression: null,
        identityDefinition: null,
        generatedDefinition: null,
    };
}

const targetSchema: PgSchemaInfo = {
    formatVersion: 1,
    engineVersion: "18.6",
    schemas: ["app"],
    objects: [
        column("id", false),
        column("left_value", true),
        column("right_value", true),
        column("note", true),
    ],
};

function context(): CompileDataContext {
    const rewriter: RelationRewriter = {
        rewrite(_request: RelationRewriteRequest): ValidationResult<string> {
            return {
                ok: true,
                value: [
                    'SELECT 1::bigint AS "__source_id", 1::integer AS "id",',
                    '       \'right\'::text AS "left_after", \'left\'::text AS "right_after"',
                ].join("\n"),
            };
        },
    };
    return {
        migrationId: "A-B",
        schema: "app",
        transformation,
        sourceQuery: {ref: migration.source.query, text: sourceSql},
        transformationQuery: {ref: transformation.query, text: transformationSql},
        lineageQuery: null,
        relationRewriter: rewriter,
        targetSnapshot,
        targetSchema,
    };
}

type StatementShape = {phase: string; text: string; values: readonly unknown[]};
type ConservationShape = {
    temporary: CompiledDataMigration["temporary"];
    statements: readonly StatementShape[];
    conservationChecks?: readonly ResourceRefInfo[];
};

function ok(result: ValidationResult<CompiledDataMigration>): ConservationShape {
    if (!result.ok) assert.fail(JSON.stringify(result.problems));
    return result.value as unknown as ConservationShape;
}

function phaseStatements(compiled: ConservationShape, phase: string): readonly StatementShape[] {
    return compiled.statements.filter(statement => statement.phase === phase);
}

describe("T20 data conservation and preservation compilation", () => {
    it("captures destination state before every write while keeping original source/output materialized for cyclic transfers", () => {
        const compiled = ok(compileDataMigration(migration, context()));
        const capture = compiled.statements.findIndex(statement => statement.phase === "capture");
        const transform = compiled.statements.findIndex(statement => statement.phase === "transform");
        const preserve = compiled.statements.findIndex(statement => statement.phase === "preserve");
        const write = compiled.statements.findIndex(statement => statement.phase === "write");

        assert.ok(capture >= 0 && transform > capture);
        assert.ok(preserve > transform && write > preserve);
        const preserveSql = compiled.statements[preserve]?.text ?? "";
        assert.match(preserveSql, /CREATE TEMP TABLE/i);
        assert.match(preserveSql, /FROM "app"\."people"/);
        assert.match(preserveSql, /"left_value"/);
        assert.match(preserveSql, /"right_value"/);
    });

    it("verifies each written field against the materialized output with null-sensitive equality", () => {
        const compiled = ok(compileDataMigration(migration, context()));
        const verification = phaseStatements(compiled, "verify").join("\n");

        assert.match(verification, /IS DISTINCT FROM/);
        assert.match(verification, /"left_value"/);
        assert.match(verification, /"left_after"/);
        assert.match(verification, /"right_value"/);
        assert.match(verification, /"right_after"/);
    });

    it("proves untouched columns and rows outside the write scope are unchanged from the before capture", () => {
        const compiled = ok(compileDataMigration(migration, context()));
        const verification = phaseStatements(compiled, "verify").join("\n");

        assert.match(verification, /"note"/);
        assert.match(verification, /IS DISTINCT FROM/);
        assert.match(verification, /NOT EXISTS|FULL JOIN/i);
        assert.match(verification, /before|preserv/i);
        const lastWrite = compiled.statements.map(statement => statement.phase).lastIndexOf("write");
        const firstVerify = compiled.statements.findIndex(statement => statement.phase === "verify");
        assert.ok(firstVerify > lastWrite);
    });

    it("carries authored conservation checks exactly once for the runner checkpoint layer", () => {
        const compiled = ok(compileDataMigration(migration, context()));
        assert.deepEqual(compiled.conservationChecks, [conservationCheck]);
    });
});

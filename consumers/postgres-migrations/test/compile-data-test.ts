import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import type {
    DataMigrationInfo,
    QueryRefInfo,
    TransformationInfo,
} from "../src/migration-authoring";
import {compileDataMigration} from "../src/compile-data";

function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function query(name: string, text: string): QueryRefInfo {
    return {name, kind: "query", contentHash: hashText(text)};
}

const sourceSql = [
    'SELECT "p"."id" AS "id", "p"."old" AS "old"',
    'FROM "app"."people" AS "p";',
    "",
].join("\n");

const transformationSql = [
    'SELECT i.__source_id, i.id, i.old AS fresh',
    'FROM migration_input AS i;',
    "",
].join("\n");

const transformation: TransformationInfo = {
    name: "move-old",
    version: "1",
    inputs: {
        id: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "people", field: "id"},
        },
        old: {
            domain: {side: "from", type: "text", nullable: true},
            field: {side: "from", entity: "people", field: "old"},
        },
    },
    parameters: {},
    outputs: {
        id: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "people", field: "id"},
        },
        fresh: {
            domain: {side: "to", type: "text", nullable: true},
            field: {side: "to", entity: "people", field: "fresh"},
        },
    },
    mode: "row",
    query: query("move-old.sql", transformationSql),
    lineage: null,
    before: [],
    after: [],
};

const migration: DataMigrationInfo = {
    id: "move-old-data",
    description: "",
    dependsOn: [],
    source: {
        query: query("people-source.sql", sourceSql),
        ports: transformation.inputs,
        identity: ["id"],
        coverageChecks: [],
    },
    transformation: "move-old",
    arguments: {},
    writes: [{
        kind: "update",
        entity: "people",
        values: [{
            output: "fresh",
            target: {side: "to", entity: "people", field: "fresh"},
        }],
        match: [{output: "id", targetField: "id"}],
        whenMissing: "error",
    }],
    conservationChecks: [],
};

type RelationRewriteRequest = {
    sql: string;
    relations: {migration_input: string; migration_parameters: string};
};

type RelationRewriter = {
    rewrite(request: RelationRewriteRequest): ValidationResult<string>;
};

type StatementShape = {
    phase: string;
    text: string;
    values: readonly unknown[];
};

type CompiledShape = {
    temporary: {
        input: string;
        parameters: string;
        output: string;
        lineage: string | null;
    };
    statements: readonly StatementShape[];
};

type CompileContextShape = {
    migrationId: string;
    schema: string;
    transformation: TransformationInfo;
    sourceQuery: {ref: QueryRefInfo; text: string};
    transformationQuery: {ref: QueryRefInfo; text: string};
    lineageQuery: null;
    relationRewriter: RelationRewriter;
};

function ok(result: ValidationResult<unknown>): CompiledShape {
    if (!result.ok) assert.fail(JSON.stringify(result.problems));
    return result.value as CompiledShape;
}

function recordingRewriter(calls: RelationRewriteRequest[]): RelationRewriter {
    return {
        rewrite(request: RelationRewriteRequest) {
            calls.push(request);
            return {
                ok: true,
                value: 'SELECT 1::bigint AS "__source_id", 1 AS "id", NULL::text AS "fresh"',
            };
        },
    };
}

function context(calls: RelationRewriteRequest[]): CompileContextShape {
    return {
        migrationId: "A-B",
        schema: "app",
        transformation,
        sourceQuery: {ref: migration.source.query, text: sourceSql},
        transformationQuery: {ref: transformation.query, text: transformationSql},
        lineageQuery: null,
        relationRewriter: recordingRewriter(calls),
    };
}

function statement(compiled: CompiledShape, phase: string): StatementShape {
    const found = compiled.statements.find((item: StatementShape) => item.phase === phase);
    if (found === undefined) assert.fail(`missing ${phase} statement`);
    return found;
}

describe("T20 row data SQL compilation", () => {
    it("materializes source identity deterministically and rewrites only logical relations through the parser port", () => {
        const calls: RelationRewriteRequest[] = [];
        const first = ok(compileDataMigration(migration, context(calls)));
        const second = ok(compileDataMigration(migration, context([])));

        assert.deepEqual(first.temporary, second.temporary);
        const capture = statement(first, "capture");
        assert.match(capture.text, /row_number\(\) OVER \(ORDER BY "id"\) AS "__source_id"/);
        assert.match(capture.text, /CREATE TEMP TABLE/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.sql, transformationSql);
        assert.deepEqual(calls[0]?.relations, {
            migration_input: first.temporary.input,
            migration_parameters: first.temporary.parameters,
        });
        const transformed = statement(first, "transform");
        assert.doesNotMatch(transformed.text, /migration_input|migration_parameters/);
    });

    it("places the row-protocol guard before writes and checks duplicate, foreign and missing source ids", () => {
        const compiled = ok(compileDataMigration(migration, context([])));
        const protocolIndex = compiled.statements.findIndex((item: StatementShape) => item.phase === "protocol");
        const writeIndex = compiled.statements.findIndex((item: StatementShape) => item.phase === "write");
        assert.ok(protocolIndex >= 0 && writeIndex > protocolIndex);

        const protocol = statement(compiled, "protocol").text;
        assert.match(protocol, /GROUP BY "__source_id"[\s\S]*HAVING count\(\*\) <> 1/);
        assert.match(protocol, /LEFT JOIN/);
        assert.match(protocol, new RegExp(firstRegex(compiled.temporary.input)));
        assert.match(protocol, new RegExp(firstRegex(compiled.temporary.output)));
    });

    it("checks update match cardinality before UPDATE and uses null-sensitive equality", () => {
        const compiled = ok(compileDataMigration(migration, context([])));
        const prewriteIndex = compiled.statements.findIndex((item: StatementShape) => item.phase === "prewrite");
        const writeIndex = compiled.statements.findIndex((item: StatementShape) => item.phase === "write");
        assert.ok(prewriteIndex >= 0 && writeIndex > prewriteIndex);

        const prewrite = statement(compiled, "prewrite").text;
        assert.match(prewrite, /count\("target"\.ctid\) <> 1/i);
        assert.match(prewrite, /IS NOT DISTINCT FROM/);
        const write = statement(compiled, "write").text;
        assert.match(write, /^UPDATE /);
        assert.match(write, /IS NOT DISTINCT FROM/);
    });

    it("verifies exact query bytes before invoking the SQL relation rewriter", () => {
        const calls: RelationRewriteRequest[] = [];
        const badContext = context(calls);
        const result = compileDataMigration(migration, {
            ...badContext,
            transformationQuery: {
                ref: badContext.transformationQuery.ref,
                text: `${badContext.transformationQuery.text} `,
            },
        });
        assert.equal(result.ok, false);
        assert.equal(calls.length, 0);
    });
});

function firstRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

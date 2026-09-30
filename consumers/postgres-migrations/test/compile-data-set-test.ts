import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import type {
    DataMigrationInfo,
    QueryRefInfo,
    TransformationInfo,
} from "../src/migration-authoring";
import {
    compileDataMigration,
    type CompileDataContext,
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
    'SELECT "p"."id" AS "id", "p"."group_id" AS "group_id", "p"."amount" AS "amount"',
    'FROM "app"."payments" AS "p";',
    "",
].join("\n");

const transformationSql = [
    "SELECT ('group:' || i.group_id::text) AS __output_id,",
    "       i.group_id, sum(i.amount)::integer AS total",
    "FROM migration_input AS i",
    "GROUP BY i.group_id;",
    "",
].join("\n");

const lineageSql = [
    "SELECT i.__source_id, ('group:' || i.group_id::text) AS __output_id",
    "FROM migration_input AS i;",
    "",
].join("\n");

const transformation: TransformationInfo = {
    name: "sum-groups",
    version: "1",
    inputs: {
        id: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "payments", field: "id"},
        },
        group_id: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "payments", field: "group_id"},
        },
        amount: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "payments", field: "amount"},
        },
    },
    parameters: {},
    outputs: {
        group_id: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "summary", field: "group_id"},
        },
        total: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "summary", field: "total"},
        },
    },
    mode: "set",
    query: query("sum-groups.sql", transformationSql),
    lineage: query("sum-groups-lineage.sql", lineageSql),
    before: [],
    after: [],
};

const migration: DataMigrationInfo = {
    id: "sum-group-data",
    description: "",
    dependsOn: [],
    source: {
        query: query("payments-source.sql", sourceSql),
        ports: transformation.inputs,
        identity: ["id"],
        coverageChecks: [],
    },
    transformation: "sum-groups",
    arguments: {},
    writes: [{
        kind: "update",
        entity: "summary",
        values: [{
            output: "total",
            target: {side: "to", entity: "summary", field: "total"},
        }],
        match: [{output: "group_id", targetField: "group_id"}],
        whenMissing: "error",
    }],
    conservationChecks: [{
        name: "group-total-conserved",
        kind: "check",
        contentHash: "3".repeat(64),
    }],
};

type StatementShape = {phase: string; text: string; values: readonly unknown[]};
type CompiledShape = {
    temporary: {input: string; parameters: string; output: string; lineage: string | null};
    statements: readonly StatementShape[];
};

function ok(result: ValidationResult<unknown>): CompiledShape {
    if (!result.ok) assert.fail(JSON.stringify(result.problems));
    return result.value as CompiledShape;
}

function statement(compiled: CompiledShape, phase: string): StatementShape {
    const found = compiled.statements.find(item => item.phase === phase);
    if (found === undefined) assert.fail(`missing ${phase} statement`);
    return found;
}

function recordingRewriter(calls: RelationRewriteRequest[]): RelationRewriter {
    return {
        rewrite(request: RelationRewriteRequest) {
            calls.push(request);
            if (request.sql === lineageSql) {
                return {ok: true, value: 'SELECT 1::bigint AS "__source_id", \'group:1\'::text AS "__output_id"'};
            }
            return {
                ok: true,
                value: 'SELECT \'group:1\'::text AS "__output_id", 1::integer AS "group_id", 10::integer AS "total"',
            };
        },
    };
}

function context(calls: RelationRewriteRequest[]): CompileDataContext {
    return {
        migrationId: "A-B",
        schema: "app",
        transformation,
        sourceQuery: {ref: migration.source.query, text: sourceSql},
        transformationQuery: {ref: transformation.query, text: transformationSql},
        lineageQuery: {ref: transformation.lineage!, text: lineageSql},
        relationRewriter: recordingRewriter(calls),
    };
}

function escaped(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("T20 set-mode data SQL compilation", () => {
    it("materializes set output and lineage once and rewrites both logical queries through the parser port", () => {
        const calls: RelationRewriteRequest[] = [];
        const compiled = ok(compileDataMigration(migration, context(calls)));

        assert.ok(compiled.temporary.lineage);
        assert.equal(calls.length, 2);
        assert.equal(calls[0]?.sql, transformationSql);
        assert.equal(calls[1]?.sql, lineageSql);
        assert.deepEqual(calls[0]?.relations, calls[1]?.relations);

        const transformIndex = compiled.statements.findIndex(item => item.phase === "transform");
        const lineageIndex = compiled.statements.findIndex(item => item.phase === "lineage");
        const protocolIndex = compiled.statements.findIndex(item => item.phase === "protocol");
        assert.ok(transformIndex >= 0 && lineageIndex > transformIndex && protocolIndex > lineageIndex);
        assert.match(statement(compiled, "lineage").text, new RegExp(escaped(compiled.temporary.lineage!)));
    });

    it("guards unique non-null output ids, valid lineage pairs and complete source/output coverage before writes", () => {
        const compiled = ok(compileDataMigration(migration, context([])));
        const protocol = statement(compiled, "protocol").text;

        assert.match(protocol, /"__output_id" IS NULL/);
        assert.match(protocol, /GROUP BY "__output_id"[\s\S]*HAVING count\(\*\) <> 1/);
        assert.match(protocol, /GROUP BY "__source_id", "__output_id"[\s\S]*HAVING count\(\*\) <> 1/);
        assert.match(protocol, new RegExp(escaped(compiled.temporary.input)));
        assert.match(protocol, new RegExp(escaped(compiled.temporary.output)));
        assert.match(protocol, new RegExp(escaped(compiled.temporary.lineage!)));
        assert.match(protocol, /LEFT JOIN/);

        const protocolIndex = compiled.statements.findIndex(item => item.phase === "protocol");
        const writeIndex = compiled.statements.findIndex(item => item.phase === "write");
        assert.ok(protocolIndex >= 0 && writeIndex > protocolIndex);
    });

    it("checks update cardinality by __output_id for set output before UPDATE", () => {
        const compiled = ok(compileDataMigration(migration, context([])));
        const prewrite = statement(compiled, "prewrite").text;
        assert.match(prewrite, /SELECT "output"\."__output_id"/);
        assert.match(prewrite, /GROUP BY "output"\."__output_id"/);
        assert.doesNotMatch(prewrite, /"output"\."__source_id"/);
        assert.match(prewrite, /count\("target"\.ctid\) <> 1/i);
        assert.match(statement(compiled, "write").text, /IS NOT DISTINCT FROM/);
    });

    it("verifies exact lineage query bytes before invoking either SQL rewriter", () => {
        const calls: RelationRewriteRequest[] = [];
        const bad = context(calls);
        const result = compileDataMigration(migration, {
            ...bad,
            lineageQuery: bad.lineageQuery === null ? null : {
                ref: bad.lineageQuery.ref,
                text: `${bad.lineageQuery.text} `,
            },
        });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail("tampered lineage bytes must fail");
        assert.equal(result.problems[0]?.details?.reason, "lineage query bytes do not match their content hash");
        assert.equal(calls.length, 0);
    });
});

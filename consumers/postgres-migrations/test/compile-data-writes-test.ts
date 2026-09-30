import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {
    ValidationResult,
    SystemSnapshotInfo,
} from "system-definition";
import type {PgSchemaInfo} from "../src/pg-schema";
import type {
    DataMigrationInfo,
    QueryRefInfo,
    TransformationInfo,
} from "../src/migration-authoring";
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

const sourceSql = 'SELECT 1::integer AS "id", \'new\'::text AS "required";\n';
const transformationSql = [
    'SELECT i.__source_id, i.id, i.required, (i.required || \'!\')::text AS computed',
    'FROM migration_input AS i;',
    "",
].join("\n");

const transformation: TransformationInfo = {
    name: "write-people",
    version: "1",
    inputs: {
        id: {
            domain: {side: "from", type: "integer", nullable: false},
            field: {side: "from", entity: "people", field: "id"},
        },
        required: {
            domain: {side: "from", type: "text", nullable: false},
            field: {side: "from", entity: "people", field: "required"},
        },
    },
    parameters: {},
    outputs: {
        id: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "people", field: "id"},
        },
        required: {
            domain: {side: "to", type: "text", nullable: false},
            field: {side: "to", entity: "people", field: "required"},
        },
        computed: {
            domain: {side: "to", type: "text", nullable: false},
            field: {side: "to", entity: "people", field: "computed"},
        },
    },
    mode: "row",
    query: query("write-people.sql", transformationSql),
    lineage: null,
    before: [],
    after: [],
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
                required: {name: "required", type: "text", nullable: false},
                optional: {name: "optional", type: "text", nullable: true},
                defaulted: {name: "defaulted", type: "text", nullable: false},
                computed: {name: "computed", type: "text", nullable: false},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: [],
        },
    },
    records: {},
};

function column(
    name: string,
    nullable: boolean,
    defaultExpression: string | null = null,
    generatedDefinition: string | null = null,
): PgSchemaInfo["objects"][number] {
    return {
        kind: "column",
        identity: {
            schema: "app",
            kind: "column",
            name,
            parentName: "people",
            signature: [],
        },
        type: {
            schema: "pg_catalog",
            name: name === "id" ? "int4" : "text",
            modifiers: [],
            arrayDimensions: 0,
            collation: null,
        },
        nullable,
        defaultExpression,
        identityDefinition: null,
        generatedDefinition,
    };
}

const targetSchema: PgSchemaInfo = {
    formatVersion: 1,
    engineVersion: "18.6",
    schemas: ["app"],
    objects: [
        column("id", false),
        column("required", false),
        column("optional", true),
        column("defaulted", false, "'server-default'::text"),
        column("computed", false, null, '("required" || \'!\'::text)'),
    ],
};

function baseMigration(write: DataMigrationInfo["writes"][number]): DataMigrationInfo {
    return {
        id: "write-people-data",
        description: "",
        dependsOn: [],
        source: {
            query: query("people-source.sql", sourceSql),
            ports: transformation.inputs,
            identity: ["id"],
            coverageChecks: [],
        },
        transformation: transformation.name,
        arguments: {},
        writes: [write],
        conservationChecks: [],
    };
}

type WriteCompileContext = CompileDataContext & {
    targetSnapshot: SystemSnapshotInfo;
    targetSchema: PgSchemaInfo;
};

function context(): WriteCompileContext {
    const rewriter: RelationRewriter = {
        rewrite(_request: RelationRewriteRequest): ValidationResult<string> {
            return {
                ok: true,
                value: 'SELECT 1::bigint AS "__source_id", 1::integer AS "id", \'new\'::text AS "required", \'new!\'::text AS "computed"',
            };
        },
    };
    return {
        migrationId: "A-B",
        schema: "app",
        transformation,
        sourceQuery: {ref: query("people-source.sql", sourceSql), text: sourceSql},
        transformationQuery: {ref: transformation.query, text: transformationSql},
        lineageQuery: null,
        relationRewriter: rewriter,
        targetSnapshot,
        targetSchema,
    };
}

function ok(result: ValidationResult<CompiledDataMigration>): CompiledDataMigration {
    if (!result.ok) {
        throw new Error(JSON.stringify(result.problems));
    }
    return result.value;
}

function failureReason(result: ValidationResult<CompiledDataMigration>): string {
    if (result.ok) {
        throw new Error("expected compilation failure");
    }
    return result.problems[0]?.details?.reason ?? "";
}

function statements(compiled: CompiledDataMigration, phase: string): readonly string[] {
    return compiled.statements.filter(statement => statement.phase === phase).map(statement => statement.text);
}

describe("T20 complete destination writes", () => {
    it("inserts only supplied fields, permits nullable/defaulted/generated omissions and guards insert conflicts", () => {
        const migration = baseMigration({
            kind: "insert",
            entity: "people",
            values: [
                {output: "id", target: {side: "to", entity: "people", field: "id"}},
                {output: "required", target: {side: "to", entity: "people", field: "required"}},
            ],
            key: ["id"],
        });
        const compiled = ok(compileDataMigration(migration, context()));

        const prewrite = statements(compiled, "prewrite").join("\n");
        const write = statements(compiled, "write").join("\n");
        assert.match(prewrite, /IS NOT DISTINCT FROM/);
        assert.match(prewrite, /GROUP BY[\s\S]*HAVING count\(\*\) > 1/i);
        assert.match(prewrite, /EXISTS[\s\S]*"app"\."people"/i);
        assert.match(write, /^INSERT INTO "app"\."people"/m);
        assert.match(write, /\("id", "required"\)/);
        assert.doesNotMatch(write, /"optional"|"defaulted"|"computed"/);
    });

    it("updates existing matches and inserts only missing complete rows when whenMissing=insert", () => {
        const migration = baseMigration({
            kind: "update",
            entity: "people",
            values: [
                {output: "required", target: {side: "to", entity: "people", field: "required"}},
            ],
            match: [{output: "id", targetField: "id"}],
            whenMissing: "insert",
        });
        const compiled = ok(compileDataMigration(migration, context()));

        const prewrite = statements(compiled, "prewrite").join("\n");
        const writes = statements(compiled, "write");
        assert.match(prewrite, /HAVING count\("target"\.ctid\) > 1/i);
        assert.equal(writes.length, 2);
        assert.match(writes[0]!, /^UPDATE /);
        assert.match(writes[1]!, /^INSERT INTO /);
        assert.match(writes[1]!, /WHERE NOT EXISTS/i);
        assert.match(writes[1]!, /IS NOT DISTINCT FROM/);
        assert.match(writes[1]!, /\("id", "required"\)/);
    });

    it("rejects missing mandatory insert fields and explicit writes to generated columns", () => {
        const incomplete = baseMigration({
            kind: "insert",
            entity: "people",
            values: [
                {output: "id", target: {side: "to", entity: "people", field: "id"}},
            ],
            key: ["id"],
        });
        assert.equal(
            failureReason(compileDataMigration(incomplete, context())),
            "insert is missing a required destination field",
        );

        const generated = baseMigration({
            kind: "insert",
            entity: "people",
            values: [
                {output: "id", target: {side: "to", entity: "people", field: "id"}},
                {output: "required", target: {side: "to", entity: "people", field: "required"}},
                {output: "computed", target: {side: "to", entity: "people", field: "computed"}},
            ],
            key: ["id"],
        });
        assert.equal(
            failureReason(compileDataMigration(generated, context())),
            "generated destination fields cannot be written explicitly",
        );
    });

    it("requires a complete destination PK/UK match and forbids changing a matched field", () => {
        const nonKeyMatch = baseMigration({
            kind: "update",
            entity: "people",
            values: [
                {output: "id", target: {side: "to", entity: "people", field: "id"}},
            ],
            match: [{output: "required", targetField: "required"}],
            whenMissing: "error",
        });
        assert.equal(
            failureReason(compileDataMigration(nonKeyMatch, context())),
            "update match must cover one complete destination PK or UK",
        );

        const changesMatch = baseMigration({
            kind: "update",
            entity: "people",
            values: [
                {output: "id", target: {side: "to", entity: "people", field: "id"}},
            ],
            match: [{output: "id", targetField: "id"}],
            whenMissing: "error",
        });
        assert.equal(
            failureReason(compileDataMigration(changesMatch, context())),
            "update cannot modify a field used by its own match",
        );
    });
});

import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {PersistenceInfo, ValidationResult} from "system-definition";
import {
    compileDataMigration,
    type CompileDataContext,
    type RelationRewriteRequest,
    type RelationRewriter,
} from "../src/compile-data";
import type {
    DataMigrationInfo,
    DomainRefInfo,
    QueryRefInfo,
    TransformationInfo,
} from "../src/migration-authoring";
import type {StorageContext} from "../src/pg-schema";

function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function query(name: string, text: string): QueryRefInfo {
    return {name, kind: "query", contentHash: hashText(text)};
}

const sourceSql = 'SELECT 1::integer AS "id";\n';
const transformationSql = [
    "SELECT i.__source_id, i.id, p.note AS fresh",
    "FROM migration_input AS i CROSS JOIN migration_parameters AS p;",
    "",
].join("\n");

const baseInputs: TransformationInfo["inputs"] = {
    id: {
        domain: {side: "from", type: "integer", nullable: false},
        field: {side: "from", entity: "people", field: "id"},
    },
};

const outputs: TransformationInfo["outputs"] = {
    id: {
        domain: {side: "to", type: "integer", nullable: false},
        field: {side: "to", entity: "people", field: "id"},
    },
    fresh: {
        domain: {side: "to", type: "text", nullable: true},
        field: {side: "to", entity: "people", field: "fresh"},
    },
};

function transformation(parameters: Readonly<Record<string, DomainRefInfo>>): TransformationInfo {
    return {
        name: "parameterized",
        version: "1",
        inputs: baseInputs,
        parameters,
        outputs,
        mode: "row",
        query: query("parameterized.sql", transformationSql),
        lineage: null,
        before: [],
        after: [],
    };
}

function migration(
    tx: TransformationInfo,
    args: DataMigrationInfo["arguments"],
): DataMigrationInfo {
    return {
        id: "parameterized-data",
        description: "",
        dependsOn: [],
        source: {
            query: query("parameter-source.sql", sourceSql),
            ports: tx.inputs,
            identity: ["id"],
            coverageChecks: [],
        },
        transformation: tx.name,
        arguments: args,
        writes: [{
            kind: "update",
            entity: "people",
            values: [{output: "fresh", target: {side: "to", entity: "people", field: "fresh"}}],
            match: [{output: "id", targetField: "id"}],
            whenMissing: "error",
        }],
        conservationChecks: [],
    };
}

type MachineCodecInfo = {
    readExpression: string;
    transportType: string;
};

type ParameterStorage = StorageContext & {
    machineCodecs: Readonly<Record<string, MachineCodecInfo>>;
};

type ParameterCompileContext = CompileDataContext & {
    storage: ParameterStorage;
    persistence: PersistenceInfo;
};

type StatementShape = {phase: string; text: string; values: readonly unknown[]};
type CompiledShape = {statements: readonly StatementShape[]};

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
            return {
                ok: true,
                value: 'SELECT 1::bigint AS "__source_id", 1::integer AS "id", NULL::text AS "fresh"',
            };
        },
    };
}

function storage(): ParameterStorage {
    return {
        representation: "postgres",
        physicalTypes: {
            text: {schema: "pg_catalog", name: "text", modifiers: []},
            integer: {schema: "pg_catalog", name: "int4", modifiers: []},
            boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
            date: {schema: "pg_catalog", name: "date", modifiers: []},
        },
        machineCodecs: {
            text: {readExpression: "migration_value", transportType: "text"},
            integer: {readExpression: "migration_value::text", transportType: "text"},
            boolean: {
                readExpression: "CASE WHEN migration_value THEN 'true' ELSE 'false' END",
                transportType: "text",
            },
            date: {readExpression: "to_char(migration_value, 'YYYY-MM-DD')", transportType: "text"},
        },
        schema: "app",
        environment: {
            engine: "postgresql",
            version: "18.6",
            serverVersionNum: 180006,
            encoding: "UTF8",
            collations: {},
            externalDependencies: {},
        },
        resources: {},
        createResources: [],
        managedData: [],
        invariantChecks: [],
    };
}

const persistence: PersistenceInfo = {
    entities: ["people"],
    representations: {
        postgres: {
            text: "text",
            integer: "integer",
            boolean: "boolean",
            date: "date",
            email: "text",
        },
    },
};

function context(
    tx: TransformationInfo,
    calls: RelationRewriteRequest[],
    override?: Partial<ParameterCompileContext>,
): ParameterCompileContext {
    return {
        migrationId: "A-B",
        schema: "app",
        transformation: tx,
        sourceQuery: {ref: query("parameter-source.sql", sourceSql), text: sourceSql},
        transformationQuery: {ref: tx.query, text: transformationSql},
        lineageQuery: null,
        relationRewriter: recordingRewriter(calls),
        storage: storage(),
        persistence,
        ...override,
    };
}

function argument(
    domain: DomainRefInfo,
    value: string | null,
): DataMigrationInfo["arguments"][string] {
    return {domain, value};
}

describe("T20 typed migration parameters and codec transport", () => {
    it("materializes one deterministic typed parameter row using driver values instead of interpolated literals", () => {
        const parameters = {
            when: {side: "to", type: "date", nullable: false},
            note: {side: "to", type: "text", nullable: true},
            enabled: {side: "to", type: "boolean", nullable: false},
            count: {side: "to", type: "integer", nullable: false},
        } as const;
        const tx = transformation(parameters);
        const data = migration(tx, {
            when: argument(parameters.when, "2026-09-30"),
            note: argument(parameters.note, "literal ' must stay a driver value"),
            enabled: argument(parameters.enabled, "true"),
            count: argument(parameters.count, "42"),
        });
        const calls: RelationRewriteRequest[] = [];
        const compiled = ok(compileDataMigration(data, context(tx, calls)));
        const params = statement(compiled, "parameters");

        assert.deepEqual(params.values, ["42", "true", "literal ' must stay a driver value", "2026-09-30"]);
        assert.match(params.text, /\$1/);
        assert.match(params.text, /\$4/);
        assert.match(params.text, /int4/i);
        assert.match(params.text, /bool/i);
        assert.match(params.text, /date/i);
        assert.doesNotMatch(params.text, /literal '/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.relations.migration_parameters.length > 0, true);
    });

    it("preserves null, empty string and the text null as three different parameter values", () => {
        const parameters = {
            absent: {side: "to", type: "text", nullable: true},
            empty: {side: "to", type: "text", nullable: false},
            word: {side: "to", type: "text", nullable: false},
        } as const;
        const tx = transformation(parameters);
        const data = migration(tx, {
            absent: argument(parameters.absent, null),
            empty: argument(parameters.empty, ""),
            word: argument(parameters.word, "null"),
        });
        const compiled = ok(compileDataMigration(data, context(tx, [])));
        const params = statement(compiled, "parameters");

        assert.deepEqual(params.values, [null, "", "null"]);
        assert.doesNotMatch(params.text, /'null'/i);
    });

    it("resolves logical domain names through the selected persistence representation rather than by matching names", () => {
        const parameters = {
            contact: {side: "to", type: "email", nullable: false},
        } as const;
        const tx = transformation(parameters);
        const data = migration(tx, {contact: argument(parameters.contact, "a@example.test")});
        const compiled = ok(compileDataMigration(data, context(tx, [])));
        const params = statement(compiled, "parameters");

        assert.deepEqual(params.values, ["a@example.test"]);
        assert.match(params.text, /text/i);
        assert.doesNotMatch(params.text, /email/i);
    });

    it("fails closed before SQL rewriting when a physical type, codec contract or transport type is missing", () => {
        const parameters = {count: {side: "to", type: "integer", nullable: false}} as const;
        const tx = transformation(parameters);
        const data = migration(tx, {count: argument(parameters.count, "42")});

        const cases: readonly {name: string; storage: ParameterStorage; reason: RegExp}[] = [
            {
                name: "physical mapping",
                storage: {...storage(), physicalTypes: {text: storage().physicalTypes.text!}},
                reason: /physical type/i,
            },
            {
                name: "codec",
                storage: {...storage(), machineCodecs: {text: storage().machineCodecs.text!}},
                reason: /codec/i,
            },
            {
                name: "transport",
                storage: {
                    ...storage(),
                    machineCodecs: {
                        ...storage().machineCodecs,
                        integer: {readExpression: "migration_value::text", transportType: "missing"},
                    },
                },
                reason: /transport/i,
            },
        ];

        for (const one of cases) {
            const calls: RelationRewriteRequest[] = [];
            const result = compileDataMigration(data, context(tx, calls, {storage: one.storage}));
            assert.equal(result.ok, false, one.name);
            if (result.ok) assert.fail(`${one.name} must fail`);
            assert.match(result.problems[0]?.details?.reason ?? "", one.reason, one.name);
            assert.equal(calls.length, 0, `${one.name} must fail before SQL rewrite`);
        }
    });
});

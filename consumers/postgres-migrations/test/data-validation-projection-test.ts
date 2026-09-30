import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    problem,
    type PersistenceInfo,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import {compileMachineEntityReadQuery} from "../src/data-validation";
import type {StorageContext} from "../src/pg-schema";

const snapshot: SystemSnapshotInfo = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["text", "integer", "boolean", "date", "email"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                email: {name: "email", type: "email", nullable: false},
                active: {name: "active", type: "boolean", nullable: false},
                born: {name: "born", type: "date", nullable: true},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: [],
        },
    },
    records: {},
};

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

function storage(): StorageContext {
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

type ProjectionField = {
    field: string;
    sourceColumn: string;
    readExpression: string;
};

type ProjectionRequest = {
    sql: string;
    entity: string;
    fields: readonly ProjectionField[];
};

type Projector = {
    project(request: ProjectionRequest): ValidationResult<string>;
};

const sourceSql = `SELECT id, email, active, born, 'migration_value must stay literal' AS note FROM app.people`;

function ok(result: ValidationResult<string>): string {
    if (!result.ok) assert.fail(JSON.stringify(result.problems));
    return result.value;
}

describe("T20 historical machine read projection", () => {
    it("resolves every complete entity field deterministically and delegates codec insertion to the AST projector", () => {
        const requests: ProjectionRequest[] = [];
        const projector: Projector = {
            project(request) {
                requests.push(request);
                return {ok: true, value: "SELECT projected"};
            },
        };

        const sql = ok(compileMachineEntityReadQuery(
            snapshot,
            "people",
            persistence,
            storage(),
            sourceSql,
            projector,
        ));

        assert.equal(sql, "SELECT projected");
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.sql, sourceSql, "compiler must not text-rewrite the source query before AST projection");
        assert.equal(requests[0]?.entity, "people");
        assert.deepEqual(requests[0]?.fields.map(field => field.field), ["active", "born", "email", "id"]);
        assert.deepEqual(requests[0]?.fields.map(field => field.sourceColumn), ["active", "born", "email", "id"]);
    });

    it("resolves logical types through persistence and passes versioned machine read expressions unchanged", () => {
        const requests: ProjectionRequest[] = [];
        ok(compileMachineEntityReadQuery(snapshot, "people", persistence, storage(), sourceSql, {
            project(request: ProjectionRequest) {
                requests.push(request);
                return {ok: true, value: "SELECT projected"};
            },
        }));

        const byField = Object.fromEntries((requests[0]?.fields ?? []).map(field => [field.field, field.readExpression]));
        assert.equal(byField.email, "migration_value", "logical email must resolve through the physical text codec");
        assert.equal(byField.id, "migration_value::text");
        assert.equal(byField.active, "CASE WHEN migration_value THEN 'true' ELSE 'false' END");
        assert.equal(byField.born, "to_char(migration_value, 'YYYY-MM-DD')");
    });

    it("fails closed before AST projection when physical mapping, codec, read expression or transport type is missing", () => {
        const base = storage();
        const cases: readonly {name: string; value: StorageContext; reason: RegExp}[] = [
            {
                name: "physical mapping",
                value: {...base, physicalTypes: {text: base.physicalTypes.text!}},
                reason: /physical type/i,
            },
            {
                name: "codec",
                value: {...base, machineCodecs: {text: base.machineCodecs!.text!}},
                reason: /codec/i,
            },
            {
                name: "read expression",
                value: {
                    ...base,
                    machineCodecs: {...base.machineCodecs!, integer: {readExpression: "", transportType: "text"}},
                },
                reason: /read expression|codec/i,
            },
            {
                name: "transport",
                value: {
                    ...base,
                    machineCodecs: {...base.machineCodecs!, integer: {readExpression: "migration_value::text", transportType: "missing"}},
                },
                reason: /transport/i,
            },
        ];

        for (const one of cases) {
            let calls = 0;
            const result = compileMachineEntityReadQuery(snapshot, "people", persistence, one.value, sourceSql, {
                project() {
                    calls++;
                    return {ok: true, value: "SELECT projected"};
                },
            });
            assert.equal(result.ok, false, one.name);
            if (result.ok) assert.fail(`${one.name} must fail`);
            assert.match(result.problems[0]?.details?.reason ?? "", one.reason, one.name);
            assert.equal(calls, 0, `${one.name} must fail before AST projection`);
        }
    });

    it("propagates AST projection failure instead of returning the unprojected physical query", () => {
        const result = compileMachineEntityReadQuery(snapshot, "people", persistence, storage(), sourceSql, {
            project() {
                return {ok: false, problems: [problem(null, "migration.machineProjectionRejected", "blocking")]};
            },
        });

        assert.equal(result.ok, false);
        if (result.ok) assert.fail("projection failure must block");
        assert.equal(result.problems[0]?.messageKey, "migration.machineProjectionRejected");
    });
});

import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    captureSystemSnapshot,
    type PersistenceInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {aida, entityDefs} from "system-definition/examples";
import {
    checkPostgres18_6,
    projectSchema,
    quotePgIdentifier,
    type PgSession,
    type StorageContext,
} from "../src/pg-schema";
import {generateCreate} from "../src/generate-create";

const storage: StorageContext = {
    representation: "postgres",
    physicalTypes: {
        text: {schema: "pg_catalog", name: "text", modifiers: []},
        integer: {schema: "pg_catalog", name: "int4", modifiers: []},
        boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
        date: {schema: "pg_catalog", name: "date", modifiers: []},
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

function aidaInputs(): {snapshot: SystemSnapshotInfo, persistence: PersistenceInfo} {
    const captured = captureSystemSnapshot(aida, {systemId: "aida", entities: entityDefs});
    assert.equal(captured.ok, true);
    if (!captured.ok) throw new Error("Aida snapshot fixture must be valid");

    const persistence: PersistenceInfo = {
        entities: Object.keys(entityDefs),
        representations: {
            postgres: {
                text: "text",
                integer: "integer",
                boolean: "boolean",
                fecha: "date",
                email: "text",
            },
        },
    };
    return {snapshot: captured.value, persistence};
}

function cyclicInputs(): {snapshot: SystemSnapshotInfo, persistence: PersistenceInfo} {
    const field = (name: string) => ({name, type: "text", nullable: false});
    return {
        snapshot: {
            formatVersion: 1,
            systemId: "cycle",
            typeNames: ["text"],
            entities: {
                alpha: {
                    name: "alpha",
                    record: "alpha",
                    fields: {id: field("id"), beta_id: field("beta_id")},
                    pk: ["id"],
                    uks: {},
                    fks: {beta: {entity: "beta", fields: {beta_id: "id"}}},
                    validators: [],
                },
                beta: {
                    name: "beta",
                    record: "beta",
                    fields: {id: field("id"), alpha_id: field("alpha_id")},
                    pk: ["id"],
                    uks: {},
                    fks: {alpha: {entity: "alpha", fields: {alpha_id: "id"}}},
                    validators: [],
                },
            },
            records: {},
        },
        persistence: {
            entities: ["alpha", "beta"],
            representations: {postgres: {text: "text"}},
        },
    };
}

function firstProblemKey(result: {ok: boolean, problems?: readonly {messageKey: string}[]}): string | undefined {
    return result.ok ? undefined : result.problems?.[0]?.messageKey;
}

describe("PostgreSQL schema projection and clean creation", () => {
    it("projects composite PK/UK/FK shapes and the effective NOT NULL already present in Info", () => {
        const {snapshot, persistence} = aidaInputs();
        const projected = projectSchema(snapshot, persistence, storage);
        assert.equal(projected.ok, true);
        if (!projected.ok) return;

        const clases = projected.value.tables.find((one: {name: string}) => one.name === "clases");
        assert.ok(clases);
        assert.deepEqual(clases.primaryKey.columns, ["periodo", "materia", "orden"]);
        assert.equal(clases.columns.find((one: {name: string}) => one.name === "periodo")?.nullable, false);
        assert.deepEqual(clases.foreignKeys[0]?.columns, [
            {source: "periodo", target: "periodo"},
            {source: "materia", target: "materia"},
        ]);

        const materias = projected.value.tables.find((one: {name: string}) => one.name === "materias");
        assert.ok(materias);
        assert.deepEqual(materias.uniqueKeys.find((one: {name: string}) => one.name.includes("denominacion"))?.columns, ["denominacion"]);
    });

    it("keeps reflexive and circular foreign keys because every table is created before any FK", () => {
        const aidaFixture = aidaInputs();
        const aidaSchema = projectSchema(aidaFixture.snapshot, aidaFixture.persistence, storage);
        assert.equal(aidaSchema.ok, true);
        if (!aidaSchema.ok) return;
        const docentes = aidaSchema.value.tables.find((one: {name: string}) => one.name === "docentes");
        assert.equal(docentes?.foreignKeys[0]?.target.name, "docentes");

        const cycle = cyclicInputs();
        const cycleSchema = projectSchema(cycle.snapshot, cycle.persistence, storage);
        assert.equal(cycleSchema.ok, true);
        if (!cycleSchema.ok) return;
        const plan = generateCreate(cycleSchema.value);
        assert.equal(plan.ok, true);
        if (!plan.ok) return;

        const firstFk = plan.value.statements.findIndex((one: {phase: string}) => one.phase === "foreign-key");
        const lastTable = plan.value.statements.reduce(
            (last: number, one: {phase: string}, index: number) => one.phase === "table" ? index : last,
            -1,
        );
        assert.ok(firstFk > lastTable);
        assert.equal(plan.value.statements.filter((one: {phase: string}) => one.phase === "foreign-key").length, 2);
    });

    it("uses the selected representation exhaustively and blocks unknown physical mappings", () => {
        const {snapshot, persistence} = aidaInputs();
        assert.equal(projectSchema(snapshot, persistence, storage).ok, true);

        const missingPhysical = {
            ...storage,
            physicalTypes: {text: storage.physicalTypes.text},
        } as StorageContext;
        const missing = projectSchema(snapshot, persistence, missingPhysical);
        assert.equal(missing.ok, false);

        const wrongRepresentation = {...storage, representation: "does-not-exist"} as StorageContext;
        const unknown = projectSchema(snapshot, persistence, wrongRepresentation);
        assert.equal(unknown.ok, false);
    });

    it("quotes identifiers component-by-component and emits DDL with no interpolated value parameters", () => {
        assert.equal(quotePgIdentifier("plain"), '"plain"');
        assert.equal(quotePgIdentifier('a"b'), '"a""b"');

        const {snapshot, persistence} = aidaInputs();
        const projected = projectSchema(snapshot, persistence, storage);
        assert.equal(projected.ok, true);
        if (!projected.ok) return;
        const plan = generateCreate(projected.value);
        assert.equal(plan.ok, true);
        if (!plan.ok) return;

        assert.ok(plan.value.statements.length > 0);
        assert.ok(plan.value.statements.every((one: {text: string, values: readonly unknown[]}) => one.text.includes('"app".') && one.values.length === 0));
        assert.ok(plan.value.statements.some((one: {text: string}) => one.text.includes('"clases"')));
    });

    it("checks exactly PostgreSQL server_version_num 180006", async () => {
        function session(version: string): PgSession {
            return {
                async query(text: string, values: readonly (null | boolean | number | string | Uint8Array)[]) {
                    assert.equal(values.length, 0);
                    assert.match(text.toLowerCase(), /server_version_num/);
                    return {rows: [{server_version_num: version}], rowCount: 1};
                },
                async close() {},
            };
        }

        const exact = await checkPostgres18_6(session("180006"));
        assert.equal(exact.ok, true);
        if (exact.ok) assert.equal(exact.value.serverVersionNum, 180006);

        const patchMismatch = await checkPostgres18_6(session("180005"));
        assert.equal(patchMismatch.ok, false);
        assert.equal(firstProblemKey(patchMismatch), "migration.environmentMismatch");

        const majorMismatch = await checkPostgres18_6(session("170012"));
        assert.equal(majorMismatch.ok, false);
        assert.equal(firstProblemKey(majorMismatch), "migration.environmentMismatch");
    });
});

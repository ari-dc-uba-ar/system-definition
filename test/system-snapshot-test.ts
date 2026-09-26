import * as assert from "assert";
import {defineRecord} from "../src/common/ssot-record";
import {defineEntities, defineEntity, withRecords} from "../src/common/ssot-entity";
import type {Problem} from "../src/common/problem";
import {captureSystemSnapshot, decodeSystemSnapshot, SystemSnapshotInfo} from "../src/common/system-snapshot";
import {
    aida,
    alumnoSearchParams,
    entityDefs,
    recordDefs,
} from "../examples/common/aida";
import {aidaConReglas, aidaTypes} from "../examples/common/aida-context";

function assertInvalid(result: ReturnType<typeof decodeSystemSnapshot>): void {
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.problems.length > 0);
        assert.ok(result.problems.some((one: Problem) => one.severity === "blocking"));
    }
}

function captureAida(): SystemSnapshotInfo {
    const result = captureSystemSnapshot(aida, {
        systemId: "aida",
        entities: entityDefs,
        records: {...recordDefs, alumnoSearchParams},
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("aida snapshot did not capture");
    return result.value;
}

function externalCopy(): SystemSnapshotInfo {
    return JSON.parse(JSON.stringify(captureAida())) as SystemSnapshotInfo;
}

describe("system snapshot capture", function () {
    it("keeps composite pks and the effective NOT NULL of every pk field", function () {
        const snapshot = captureAida();
        assert.deepEqual(snapshot.entities.clases.pk, ["periodo", "materia", "orden"]);
        for (const fieldName of snapshot.entities.clases.pk) {
            assert.equal(snapshot.entities.clases.fields[fieldName].nullable, false);
        }
    });

    it("keeps system-specific field metadata and standalone records", function () {
        const snapshot = captureAida();
        const denomination = snapshot.entities.materias.fields.denominacion;

        assert.equal(denomination.type, "text");
        assert.equal(denomination.nullable, false);
        assert.equal(denomination.isName, true);
        assert.equal(denomination.label, "denominación");
        assert.equal(
            denomination.description,
            "si corresponde a más de una carrera, aclarar en el nombre",
        );

        assert.equal(snapshot.records.alumnoSearchParams.apellido.type, "text");
        assert.equal(snapshot.records.alumnoSearchParams.desde.type, "fecha");
        assert.deepEqual(new Set(snapshot.typeNames), new Set(Object.keys(aida.types)));
    });

    it("returns a detached JSON copy rather than aliases into the source defs", function () {
        const localRecord = defineRecord(aidaTypes, {
            id: {type: "text"},
            title: {type: "text", label: "before"},
        });
        const localContext = withRecords(aidaConReglas, {localRecord});
        const localEntity = defineEntity(localContext, {
            name: "locals",
            record: "localRecord",
            pk: ["id"],
        });
        const localEntities = defineEntities({locals: localEntity});

        const result = captureSystemSnapshot(localContext, {
            systemId: "local",
            entities: localEntities,
            records: {localRecord},
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        (localRecord.title as {label?: string}).label = "after";
        (localEntity.pk as unknown as string[]).push("title");

        assert.equal(result.value.entities.locals.fields.title.label, "before");
        assert.deepEqual(result.value.entities.locals.pk, ["id"]);
        assert.equal(result.value.records.localRecord.title.label, "before");
    });

    it("rejects runtime-invalid defs instead of trusting their TypeScript cast", function () {
        const wrongName = {
            ...entityDefs,
            materias: {...entityDefs.materias, name: "not-materias"},
        } as unknown as typeof entityDefs;
        const result = captureSystemSnapshot(aida, {
            systemId: "aida",
            entities: wrongName,
        });
        assert.equal(result.ok, false);
        if (!result.ok) assert.ok(result.problems.some((one: Problem) => one.severity === "blocking"));
    });
});

describe("system snapshot decoder", function () {
    it("accepts a serialized valid snapshot and returns a detached copy", function () {
        const source = externalCopy();
        const result = decodeSystemSnapshot(source);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        const original = result.value.entities.materias.fields.denominacion.label;
        (source.entities.materias.fields.denominacion as unknown as Record<string, unknown>).label = "changed externally";
        assert.equal(result.value.entities.materias.fields.denominacion.label, original);
    });

    it("rejects empty ids, wrong format versions, unknown types, and extra top-level fields", function () {
        const emptyId = externalCopy();
        emptyId.systemId = "";
        assertInvalid(decodeSystemSnapshot(emptyId));

        const wrongVersion = externalCopy() as unknown as Record<string, unknown>;
        wrongVersion.formatVersion = 2;
        assertInvalid(decodeSystemSnapshot(wrongVersion));

        const unknownType = externalCopy();
        unknownType.entities.alumnos.fields.email.type = "unknown";
        assertInvalid(decodeSystemSnapshot(unknownType));

        const extra = externalCopy() as unknown as Record<string, unknown>;
        extra.unexpected = true;
        assertInvalid(decodeSystemSnapshot(extra));
    });

    it("rejects discordant names, missing fields, empty keys, and nullable pk fields", function () {
        const wrongName = externalCopy();
        wrongName.entities.materias.name = "wrong";
        assertInvalid(decodeSystemSnapshot(wrongName));

        const missingPkField = externalCopy();
        missingPkField.entities.materias.pk = ["missing"];
        assertInvalid(decodeSystemSnapshot(missingPkField));

        const emptyPk = externalCopy();
        emptyPk.entities.materias.pk = [];
        assertInvalid(decodeSystemSnapshot(emptyPk));

        const emptyUk = externalCopy();
        emptyUk.entities.materias.uks = {...emptyUk.entities.materias.uks, denominacion: []};
        assertInvalid(decodeSystemSnapshot(emptyUk));

        const nullablePk = externalCopy();
        nullablePk.entities.clases.fields.periodo.nullable = true;
        assertInvalid(decodeSystemSnapshot(nullablePk));
    });

    it("rejects broken, partial, or repeated fk targets and requires normalized fk maps", function () {
        const missingTarget = externalCopy();
        missingTarget.entities.cursos.fks.periodos.entity = "missing";
        assertInvalid(decodeSystemSnapshot(missingTarget));

        const partialTarget = externalCopy();
        partialTarget.entities.clases.fks.cursos.fields = {periodo: "periodo"};
        assertInvalid(decodeSystemSnapshot(partialTarget));

        const repeatedTarget = externalCopy();
        repeatedTarget.entities.presencias.fks.inscripciones.fields = {
            periodo: "periodo",
            materia: "periodo",
            alumno: "alumno",
        };
        assertInvalid(decodeSystemSnapshot(repeatedTarget));

        const shorthand = externalCopy() as unknown as {
            entities: {cursos: {fks: {periodos: {fields: unknown}}}}
        };
        shorthand.entities.cursos.fks.periodos.fields = ["periodo"];
        assertInvalid(decodeSystemSnapshot(shorthand));
    });

    it("rejects non-JSON input without invoking getters", function () {
        let getterCalls = 0;
        const invalid = externalCopy() as unknown as Record<string, unknown>;
        Object.defineProperty(invalid, "danger", {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error("getter executed");
            },
        });

        assertInvalid(decodeSystemSnapshot(invalid));
        assert.equal(getterCalls, 0);
    });
});

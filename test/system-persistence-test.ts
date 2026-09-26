import * as assert from "assert";
import type {Problem} from "../src/common/problem";
import {captureSystemSnapshot, SystemSnapshotInfo} from "../src/common/system-snapshot";
import {
    completePersistence,
    decodePersistence,
    definePersistence,
    PersistenceInfo,
} from "../src/common/system-persistence";
import {
    aida,
    alumnoSearchParams,
    entityDefs,
    recordDefs,
} from "../examples/common/aida";
import {aidaPersistence} from "../examples/common/aida-persistence";

const context = {...aida, entities: entityDefs};
const typeMappings = {
    text: "text",
    integer: "integer",
    boolean: "boolean",
    fecha: "date",
    email: "text",
} as const;

function assertInvalid(result: ReturnType<typeof decodePersistence> | ReturnType<typeof completePersistence>): void {
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.ok(result.problems.length > 0);
        assert.ok(result.problems.some((one: Problem) => one.severity === "blocking"));
    }
}

function aidaSnapshot(): SystemSnapshotInfo {
    const result = captureSystemSnapshot(aida, {
        systemId: "aida",
        entities: entityDefs,
        records: {...recordDefs, alumnoSearchParams},
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("aida snapshot did not capture");
    return result.value;
}

function persistenceCopy(): PersistenceInfo {
    return JSON.parse(JSON.stringify({
        entities: aidaPersistence.entities,
        representations: aidaPersistence.representations,
    })) as PersistenceInfo;
}

describe("system persistence definition", function () {
    it("keeps Aida persistence explicit and preserves representation literals", function () {
        assert.deepEqual(aidaPersistence.entities, [
            "docentes", "materias", "periodos", "cursos", "clases", "alumnos",
            "preguntas", "opciones", "inscripciones", "presencias", "mesas",
        ]);
        assert.equal(aidaPersistence.representations.postgres.fecha, "date");
        assert.equal(aidaPersistence.representations.postgres.email, "text");
        assert.equal(aidaPersistence.entities.includes("cargos" as never), false);
    });

    it("orders the selected entities canonically and returns a detached copy", function () {
        const source = definePersistence(context, {
            entities: ["materias", "docentes"],
            representations: {postgres: typeMappings},
        });
        const result = completePersistence(context, source);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(result.value.entities, ["docentes", "materias"]);
        assert.notStrictEqual(result.value.entities, source.entities);
        assert.notStrictEqual(result.value.representations, source.representations);
        assert.notStrictEqual(result.value.representations.postgres, source.representations.postgres);
    });

    it("rejects duplicate selections and selections that are not closed over fks", function () {
        const duplicate = {
            entities: ["materias", "materias"],
            representations: {postgres: typeMappings},
        };
        assertInvalid(completePersistence(context, duplicate as never));

        const missingFkTarget = {
            entities: ["cursos", "periodos", "materias"],
            representations: {postgres: typeMappings},
        };
        assertInvalid(completePersistence(context, missingFkTarget as never));
    });

    it("does not discover standalone records or entity exports outside entityDefs", function () {
        const snapshot = aidaSnapshot();
        assert.ok(Object.prototype.hasOwnProperty.call(snapshot.records, "alumnoSearchParams"));
        assert.equal(Object.prototype.hasOwnProperty.call(snapshot.entities, "cargos"), false);

        const result = completePersistence(context, aidaPersistence);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.value.entities.includes("alumnoSearchParams" as never), false);
        assert.equal(result.value.entities.includes("cargos" as never), false);
    });

    it("rejects runtime-invalid mappings instead of trusting a TypeScript cast", function () {
        const missingFecha = {
            entities: ["materias"],
            representations: {postgres: {text: "text", integer: "integer", boolean: "boolean", email: "text"}},
        };
        assertInvalid(completePersistence(context, missingFecha as never));

        const extraType = {
            entities: ["materias"],
            representations: {postgres: {...typeMappings, money: "numeric"}},
        };
        assertInvalid(completePersistence(context, extraType as never));
    });
});

describe("system persistence decoder", function () {
    it("accepts a valid serialized persistence and returns a detached copy", function () {
        const source = persistenceCopy();
        const result = decodePersistence(source, aidaSnapshot());
        assert.equal(result.ok, true);
        if (!result.ok) return;

        (source.entities as string[])[0] = "changed";
        (source.representations.postgres as Record<string, string>).fecha = "changed";
        assert.equal(result.value.entities.includes("changed"), false);
        assert.equal(result.value.representations.postgres.fecha, "date");
    });

    it("rejects missing and extra type mappings", function () {
        const missing = persistenceCopy() as unknown as {entities: string[], representations: {postgres: Record<string, string>}};
        delete missing.representations.postgres.fecha;
        assertInvalid(decodePersistence(missing, aidaSnapshot()));

        const extra = persistenceCopy() as unknown as {entities: string[], representations: {postgres: Record<string, string>}};
        extra.representations.postgres.money = "numeric";
        assertInvalid(decodePersistence(extra, aidaSnapshot()));
    });

    it("rejects duplicates, unknown entities, standalone records, and broken fk closure", function () {
        const duplicate = persistenceCopy() as unknown as {entities: string[], representations: unknown};
        duplicate.entities.push("materias");
        assertInvalid(decodePersistence(duplicate, aidaSnapshot()));

        const cargo = persistenceCopy() as unknown as {entities: string[], representations: unknown};
        cargo.entities = ["cargos"];
        assertInvalid(decodePersistence(cargo, aidaSnapshot()));

        const standalone = persistenceCopy() as unknown as {entities: string[], representations: unknown};
        standalone.entities = ["alumnoSearchParams"];
        assertInvalid(decodePersistence(standalone, aidaSnapshot()));

        const openFk = persistenceCopy() as unknown as {entities: string[], representations: unknown};
        openFk.entities = ["cursos", "periodos", "materias"];
        assertInvalid(decodePersistence(openFk, aidaSnapshot()));
    });

    it("rejects a non-JSON external value without invoking getters", function () {
        let calls = 0;
        const invalid = persistenceCopy() as unknown as Record<string, unknown>;
        Object.defineProperty(invalid, "danger", {
            enumerable: true,
            get() {
                calls++;
                throw new Error("getter executed");
            },
        });
        assertInvalid(decodePersistence(invalid, aidaSnapshot()));
        assert.equal(calls, 0);
    });
});

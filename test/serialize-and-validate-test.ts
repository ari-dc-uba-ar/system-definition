import * as assert from "assert";

import { Problem, ValidationResult } from "../src/common/problem";
import { serializeFields, deserializeRecord, deserializeProblems } from "../src/common/serialize";
import { ValidatorNamesFor, instanceProblems, isRecordInstance, validateInstance } from "../src/common/validate";
import { RecordInstanceType } from "../src/common/ssot-record";
import { aida, aida1, aidaTypes, alumnos, cargo, clases, docente, docentes, mesa } from "../examples/common/index";
import { completeEntity, defineEntity } from "../src/common/ssot-entity";
import { validateInstance as runRules } from "../src/common/validate";

function valueOf<T>(result: ValidationResult<T>): T {
    assert.ok(result.ok, 'expected the text to deserialize: ' + JSON.stringify(result));
    return result.value;
}

function problemsOf<T>(result: ValidationResult<T>): readonly Problem[] {
    assert.ok(!result.ok, 'expected the text not to parse');
    return result.problems;
}

describe("deserializeRecord", function(){
    it("turns the text of every field into the value its type declares", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana',
            cargo: 'TIT', email: 'ana@uba.ar', email_alternativo: null, jefe: null,
        }));
        assert.equal(fila.apellido, 'Perez');
        assert.equal(fila.email_alternativo, null);
        const comoDeclara: string | null = fila.nombres;
        assert.equal(comoDeclara, 'Ana');
    })
    it("builds the composite value of a composite type", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, mesa, {
            periodo: '2026c1', materia: 'BD', fecha: '2026-07-15', presidente: null, vocal: null,
        }));
        assert.ok(fila.fecha!.equals(Temporal.PlainDate.from('2026-07-15')));
    })
    it("rejects a date with the right shape and no existence", function(){
        const problemas = problemsOf(deserializeRecord(aidaTypes, mesa, {
            periodo: '2026c1', materia: 'BD', fecha: '2026-02-31',
        }));
        assert.deepStrictEqual(problemas.map(p => [p.field, p.messageKey, p.severity]),
            [['fecha', 'type.date', 'blocking']]);
    })
    it("an empty input is the absence of a value, not the empty string", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana', email: '',
        }));
        assert.equal(fila.email, null);
    })
    it("reports what is mandatory and missing", function(){
        const problemas = problemsOf(deserializeRecord(aidaTypes, docente, {docente: '1'}));
        assert.deepStrictEqual(problemas.map(p => p.field).sort(), ['apellido', 'nombres']);
        assert.ok(problemas.every(p => p.messageKey === 'field.required'));
    })
    it("does not report them when the text is not meant to be complete", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, docente, {docente: '1'}, {requireMandatory: false}));
        assert.equal(fila.apellido, null);
    })
    it("still reports what does not read, complete or not", function(){
        const problemas = deserializeProblems(aidaTypes, mesa, {fecha: 'ayer'}, {requireMandatory: false});
        assert.deepStrictEqual(problemas.map(p => p.field), ['fecha']);
    })
})

describe("validateInstance", function(){
    type Docente = RecordInstanceType<typeof aidaTypes, typeof docente>

    const validadores = {
        emailRazonable: (fila: {email: string | null}): readonly Problem[] =>
            fila.email == null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fila.email)
                ? []
                : [{field: 'email', messageKey: 'email.forma', severity: 'regular' as const, details: {}}],
        ordenPositivo: (fila: {orden: number | null}): readonly Problem[] =>
            fila.orden == null || fila.orden > 0
                ? []
                : [{field: 'orden', messageKey: 'orden.positivo', severity: 'regular' as const, details: {}}],
    };

    it("runs the named rules over a record that is already built", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana', email: 'sin-arroba',
        }));
        const problemas = validateInstance(validadores, ['emailRazonable'], fila);
        assert.deepStrictEqual(problemas.map(p => p.messageKey), ['email.forma']);
    })
    it("collects every problem instead of stopping at the first", function(){
        const problemas = validateInstance(validadores, ['emailRazonable', 'emailRazonable'],
            {email: 'sin-arroba', orden: 1});
        assert.equal(problemas.length, 2);
    })
    it("a record may only name the rules whose shape it has", function(){
        const permitidos: ValidatorNamesFor<Docente, typeof validadores>[] = ['emailRazonable'];
        assert.deepStrictEqual(permitidos, ['emailRazonable']);
        // @ts-expect-error docente has no orden, so ordenPositivo is not among its names
        const prohibido: ValidatorNamesFor<Docente, typeof validadores>[] = ['ordenPositivo'];
        assert.ok(prohibido != null);
    })
})

describe("isRecordInstance", function(){
    it("types an anonymous object against the definition", function(){
        const anonimo: unknown = {periodo: '2026c1', materia: 'BD', fecha: Temporal.PlainDate.from('2026-07-15')};
        assert.ok(isRecordInstance(aidaTypes, mesa, anonimo));
        /* pasado el predicado el compilador sabe qué es, y lo sabe porque se miró cada valor */
        const laFecha: Temporal.PlainDate | null = anonimo.fecha;
        assert.equal(laFecha!.toString(), '2026-07-15');
    })
    it("rejects a value that is not of the type its field declares", function(){
        const conFechaDeTexto: unknown = {periodo: '2026c1', materia: 'BD', fecha: '2026-07-15'};
        assert.ok(!isRecordInstance(aidaTypes, mesa, conFechaDeTexto));
        assert.deepStrictEqual(
            instanceProblems(aidaTypes, mesa, conFechaDeTexto).map(p => [p.field, p.messageKey]),
            [['fecha', 'field.notOfItsType']],
        );
    })
    it("says which field is wrong instead of a bare false", function(){
        const problemas = instanceProblems(aidaTypes, mesa, {periodo: 1, materia: 'BD'});
        assert.deepStrictEqual(problemas.map(p => [p.field, p.messageKey]), [['periodo', 'field.notOfItsType']]);
    })
    it("a field of the record is nullable until an entity says otherwise", function(){
        /* fecha falta, y al record no le molesta: es `mesas` la que la vuelve obligatoria al
           ponerla en su pk, y eso es del nivel de la entidad y no del record */
        assert.deepStrictEqual(instanceProblems(aidaTypes, mesa, {periodo: '2026c1', materia: 'BD'}), []);
    })
    it("rejects what is not an object at all", function(){
        assert.deepStrictEqual(instanceProblems(aidaTypes, mesa, 'una mesa').map(p => p.messageKey),
            ['record.notAnObject']);
        assert.ok(!isRecordInstance(aidaTypes, mesa, null));
    })
})

describe("an entity names its own rules", function(){
    it("carries the names in the def and in the info", function(){
        assert.deepStrictEqual(docentes.validators, ['emailRazonable']);
        assert.deepStrictEqual(clases.validators, ['ordenPositivo']);
        assert.deepStrictEqual(completeEntity(aida, docentes).validators, ['emailRazonable']);
        /* una entidad que no nombra ninguna no queda con undefined */
        assert.deepStrictEqual(completeEntity(aida, alumnos).validators, ['emailRazonable']);
    })
    it("may only name a rule whose shape its row has", function(){
        const bien = defineEntity(aida1, {name: 'alumnos', record: 'alumno', pk: ['alumno'], validators: ['emailRazonable']});
        assert.deepStrictEqual(bien.validators, ['emailRazonable']);
        const mal = defineEntity(aida1, {
            name: 'alumnos', record: 'alumno', pk: ['alumno'],
            // @ts-expect-error alumno no tiene orden, así que ordenPositivo no está entre sus nombres
            validators: ['ordenPositivo'],
        });
        assert.ok(mal != null);
    })
    it("runs them over a row that was parsed first", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana', email: 'sin-arroba',
        }));
        const info = completeEntity(aida, docentes);
        assert.deepStrictEqual(
            runRules(aida.validators, info.validators, fila).map(p => [p.field, p.messageKey, p.severity]),
            [['email', 'email.forma', 'regular']],
        );
    })
    it("and says nothing when the row is fine", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana', email: 'ana@uba.ar',
        }));
        assert.deepStrictEqual(runRules(aida.validators, completeEntity(aida, docentes).validators, fila), []);
    })
})

describe("serializeFields", function(){
    it("writes each field as the text its own deserialize reads back", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, mesa, {
            periodo: '2026c1', materia: 'BD', fecha: '2026-07-15',
        }));
        assert.deepStrictEqual(serializeFields(aidaTypes, mesa, fila), {
            periodo: '2026c1', materia: 'BD', fecha: '2026-07-15', presidente: null, vocal: null,
        });
    })
    it("round-trips: what it writes is what deserializeRecord reads", function(){
        const original = {periodo: '2026c1', materia: 'BD', fecha: '2026-07-15'};
        const fila = valueOf(deserializeRecord(aidaTypes, mesa, original));
        const texto = serializeFields(aidaTypes, mesa, fila);
        const otraVez = valueOf(deserializeRecord(aidaTypes, mesa, texto));
        assert.ok(otraVez.fecha!.equals(fila.fecha!));
        assert.equal(otraVez.periodo, fila.periodo);
    })
    it("is not the human one: no locale, and the machine form of a boolean", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: 'true'}));
        assert.equal(serializeFields(aidaTypes, cargo, fila)['puede_dirigir'], 'true');
    })
})

import * as assert from "assert";

import { Problem, ValidationResult } from "../src/common/problem";
import { parseRecord, parseProblems } from "../src/common/parse";
import { ValidatorNamesFor, instanceProblems, isRecordInstance, validateInstance } from "../src/common/validate";
import { RecordInstanceType } from "../src/common/ssot-record";
import { aidaTypes, docente, mesa } from "../examples/common/index";

function valueOf<T>(result: ValidationResult<T>): T {
    assert.ok(result.ok, 'expected the text to parse: ' + JSON.stringify(result));
    return result.value;
}

function problemsOf<T>(result: ValidationResult<T>): readonly Problem[] {
    assert.ok(!result.ok, 'expected the text not to parse');
    return result.problems;
}

describe("parseRecord", function(){
    it("turns the text of every field into the value its type declares", function(){
        const fila = valueOf(parseRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana',
            cargo: 'TIT', email: 'ana@uba.ar', email_alternativo: null, jefe: null,
        }));
        assert.equal(fila.apellido, 'Perez');
        assert.equal(fila.email_alternativo, null);
        const comoDeclara: string | null = fila.nombres;
        assert.equal(comoDeclara, 'Ana');
    })
    it("builds the composite value of a composite type", function(){
        const fila = valueOf(parseRecord(aidaTypes, mesa, {
            periodo: '2026c1', materia: 'BD', fecha: '2026-07-15', presidente: null, vocal: null,
        }));
        assert.deepStrictEqual(fila.fecha, {año: 2026, mes: 7, día: 15});
    })
    it("rejects a date with the right shape and no existence", function(){
        const problemas = problemsOf(parseRecord(aidaTypes, mesa, {
            periodo: '2026c1', materia: 'BD', fecha: '2026-02-31',
        }));
        assert.deepStrictEqual(problemas.map(p => [p.field, p.messageKey, p.severity]),
            [['fecha', 'type.date', 'blocking']]);
    })
    it("an empty input is the absence of a value, not the empty string", function(){
        const fila = valueOf(parseRecord(aidaTypes, docente, {
            docente: '1', apellido: 'Perez', nombres: 'Ana', email: '',
        }));
        assert.equal(fila.email, null);
    })
    it("reports what is mandatory and missing", function(){
        const problemas = problemsOf(parseRecord(aidaTypes, docente, {docente: '1'}));
        assert.deepStrictEqual(problemas.map(p => p.field).sort(), ['apellido', 'nombres']);
        assert.ok(problemas.every(p => p.messageKey === 'field.required'));
    })
    it("does not report them when the text is not meant to be complete", function(){
        const fila = valueOf(parseRecord(aidaTypes, docente, {docente: '1'}, {requireMandatory: false}));
        assert.equal(fila.apellido, null);
    })
    it("still reports what does not read, complete or not", function(){
        const problemas = parseProblems(aidaTypes, mesa, {fecha: 'ayer'}, {requireMandatory: false});
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
        const fila = valueOf(parseRecord(aidaTypes, docente, {
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
        const anonimo: unknown = {periodo: '2026c1', materia: 'BD', fecha: {año: 2026, mes: 7, día: 15}};
        assert.ok(isRecordInstance(aidaTypes, mesa, anonimo));
        /* pasado el predicado el compilador sabe qué es, y lo sabe porque se miró cada valor */
        const laFecha: {año: number, mes: number, día: number} | null = anonimo.fecha;
        assert.deepStrictEqual(laFecha, {año: 2026, mes: 7, día: 15});
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

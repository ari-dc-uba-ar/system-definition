import * as assert from "assert";

import { ValidationResult } from "../src/common/problem";
import { deserializeRecord, deserializeProblems } from "../src/common/serialize";
import { formatFields, parseProblems, parseRecord } from "../src/common/human";
import { aidaTypes, cargo, clase, mesa } from "../examples/common/index";

function valueOf<T>(result: ValidationResult<T>): T {
    assert.ok(result.ok, 'esperaba que leyera: ' + JSON.stringify(result));
    return result.value;
}

describe("the human pair", function(){
    it("reads the same date in the order each locale writes it", function(){
        const enAR = valueOf(parseRecord(aidaTypes, mesa, {periodo: 'p', materia: 'm', fecha: '15/07/2026'}, 'es-AR'));
        const enUS = valueOf(parseRecord(aidaTypes, mesa, {periodo: 'p', materia: 'm', fecha: '7/15/2026'}, 'en-US'));
        assert.equal(enAR.fecha!.toString(), '2026-07-15');
        assert.ok(enAR.fecha!.equals(enUS.fecha!));
    })
    it("rejects in one locale what it reads in another", function(){
        /* 15 no es un mes: la misma cadena que en es-AR es el 7 de julio no se puede leer en en-US */
        assert.deepStrictEqual(
            parseProblems(aidaTypes, mesa, {periodo: 'p', materia: 'm', fecha: '15/07/2026'}, 'en-US')
                .map(p => [p.field, p.messageKey]),
            [['fecha', 'type.date']],
        );
    })
    it("writes the date back the way the locale writes it", function(){
        const fila = valueOf(parseRecord(aidaTypes, mesa, {periodo: 'p', materia: 'm', fecha: '15/07/2026'}, 'es-AR'));
        assert.equal(formatFields(aidaTypes, mesa, fila, 'es-AR')['fecha'], '15/7/2026');
        assert.equal(formatFields(aidaTypes, mesa, fila, 'en-US')['fecha'], '7/15/2026');
    })
    it("deserialize does not read what a person writes, and that is the point", function(){
        assert.deepStrictEqual(
            deserializeProblems(aidaTypes, mesa, {periodo: 'p', materia: 'm', fecha: '15/07/2026'}).map(p => p.field),
            ['fecha'],
        );
        assert.equal(valueOf(deserializeRecord(aidaTypes, mesa, {periodo: 'p', materia: 'm', fecha: '2026-07-15'}))
            .fecha!.toString(), '2026-07-15');
    })
    it("the ambiguity of the thousands separator is resolved by the locale, not by tolerance", function(){
        /* 123.456 en es-AR son ciento veintitrés mil; serializado no es ni un entero */
        const humano = valueOf(parseRecord(aidaTypes, clase,
            {periodo: 'p', materia: 'm', orden: '123.456', fecha: '15/07/2026', tema: 't'}, 'es-AR'));
        assert.equal(humano.orden, 123456);
        assert.deepStrictEqual(
            deserializeProblems(aidaTypes, clase, {periodo: 'p', materia: 'm', orden: '123.456', fecha: '2026-07-15', tema: 't'})
                .map(p => p.field),
            ['orden'],
        );
    })
    it("a type with nothing of its own falls back to deserialize/serialize", function(){
        /* text se lee igual en todo locale, así que aida no declara nada y no hace falta */
        const fila = valueOf(parseRecord(aidaTypes, mesa, {periodo: '2026c1', materia: 'BD', fecha: '15/07/2026'}, 'es-AR'));
        assert.equal(fila.periodo, '2026c1');
    })
    it("the system decides its own human form, and may ignore the locale", function(){
        /* nadie en una secretaría escribe `true`, y la jerga es de aida y no del locale */
        for (const dicho of ['S', 'si', 'Sí', 'SÍ']) {
            assert.equal(valueOf(parseRecord(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: dicho}, 'es-AR')).puede_dirigir, true);
        }
        assert.equal(valueOf(parseRecord(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: 'N'}, 'es-AR')).puede_dirigir, false);
        assert.equal(valueOf(parseRecord(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: 'no'}, 'en-US')).puede_dirigir, false);
    })
    it("and writes it back in that same jargon", function(){
        const fila = valueOf(parseRecord(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: 'S'}, 'es-AR'));
        assert.equal(formatFields(aidaTypes, cargo, fila, 'es-AR')['puede_dirigir'], 'Sí');
    })
    it("deserialize/serialize keep reading and writing true/false", function(){
        const fila = valueOf(deserializeRecord(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: 'true'}));
        assert.equal(fila.puede_dirigir, true);
        assert.deepStrictEqual(deserializeProblems(aidaTypes, cargo, {cargo: 'TIT', puede_dirigir: 'Sí'}).map(p => p.field),
            ['puede_dirigir']);
    })
    it("a null is an empty cell and not the word null", function(){
        const fila = valueOf(parseRecord(aidaTypes, mesa, {periodo: 'p', materia: 'm'}, 'es-AR'));
        assert.equal(formatFields(aidaTypes, mesa, fila, 'es-AR')['fecha'], null);
    })
})

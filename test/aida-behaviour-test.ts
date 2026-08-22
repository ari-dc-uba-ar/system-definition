import * as assert from "assert";

import { TypeProvider, TypeBehaviour, ParseResult, commonTypeBehaviours, parsed, notParsed,
    commonTypeDefs, TypeCollection
} from "../src/common/index";
import { typeDefs, typeBehaviours, fechaBehaviour } from "../examples/common/index";

type Fecha = typeof typeDefs['fecha']['tsType']

function valueOf<TsType>(result: ParseResult<TsType>): TsType {
    assert.ok(result.ok, 'expected a parsed value, got ' + (result.ok ? '' : result.messageKey));
    return result.value;
}

function messageKeyOf(result: ParseResult<unknown>): string {
    assert.ok(!result.ok, 'expected a failure');
    return result.messageKey;
}

describe("type behaviour", function(){
    it("reads and writes the common types", function(){
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.text.parse('hola')), 'hola');
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.integer.parse(' 12 ')), 12);
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.integer.parse('-3')), -3);
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.boolean.parse('TRUE')), true);
        assert.equal(commonTypeBehaviours.integer.format(12), '12');
        assert.equal(commonTypeBehaviours.boolean.format(false), 'false');
    })
    it("rejects what Number() would have accepted", function(){
        // Number('') is 0, Number('0x10') is 16 and Number('1.5') is 1.5: none of them is this integer
        assert.equal(messageKeyOf(commonTypeBehaviours.integer.parse('')), 'type.integer');
        assert.equal(messageKeyOf(commonTypeBehaviours.integer.parse('0x10')), 'type.integer');
        assert.equal(messageKeyOf(commonTypeBehaviours.integer.parse('1.5')), 'type.integer');
        assert.equal(messageKeyOf(commonTypeBehaviours.boolean.parse('sí')), 'type.boolean');
    })
    it("round-trips every common type", function(){
        assert.equal(commonTypeBehaviours.text.format(valueOf(commonTypeBehaviours.text.parse('x'))), 'x');
        assert.equal(commonTypeBehaviours.integer.format(valueOf(commonTypeBehaviours.integer.parse('42'))), '42');
        assert.equal(commonTypeBehaviours.boolean.format(valueOf(commonTypeBehaviours.boolean.parse('true'))), 'true');
    })
    it("types the parsed value after the type of the definition", function(){
        // the behaviour of `integer` yields a number, and that is checked in both directions
        var asNumber: number = valueOf(commonTypeBehaviours.integer.parse('7'));
        var asParsed: ParseResult<number> = commonTypeBehaviours.integer.parse('7');
        assert.equal(asNumber, 7);
        assert.equal(valueOf(asParsed), 7);
        // @ts-expect-error the parsed value of `integer` is not a string
        var asString: string = valueOf(commonTypeBehaviours.integer.parse('7'));
        // @ts-expect-error `format` of `integer` does not take a string either
        commonTypeBehaviours.integer.format('7');
        assert.equal(asString, 7);
    })
    it("is exhaustive over the type collection", function(){
        // a provider that covers every type of the collection is a TypeProvider of it,
        // and a TypeProvider of it covers every type: mutually assignable
        var provider: TypeProvider<typeof commonTypeDefs> = commonTypeBehaviours;
        var behaviours: typeof commonTypeBehaviours = provider;
        assert.deepStrictEqual(Object.keys(behaviours).sort(), Object.keys(commonTypeDefs).sort());
        // @ts-expect-error a provider missing a type of the collection is not a TypeProvider of it
        var incomplete: TypeProvider<typeof commonTypeDefs> = {text: commonTypeBehaviours.text};
        assert.equal(Object.keys(incomplete).length, 1);
        // @ts-expect-error a type outside the collection cannot be looked up
        var noBehaviour = commonTypeBehaviours.inexistente;
        assert.equal(noBehaviour, undefined);
    })
    it("accepts a behaviour written for the type of the definition, and no other", function(){
        var ok: TypeBehaviour<string> = {parse: (text) => parsed(text), format: (value) => value};
        assert.equal(valueOf(ok.parse('a')), 'a');
        // @ts-expect-error the parsed value has to be the type the behaviour declares
        var wrongParse: TypeBehaviour<string> = {parse: () => parsed(1), format: (value) => value};
        // @ts-expect-error and `format` has to take it
        var wrongFormat: TypeBehaviour<string> = {parse: (text) => parsed(text), format: (value: number) => String(value)};
        assert.ok(wrongParse != null && wrongFormat != null);
    })
    it("carries a message key and never a text", function(){
        var failure: ParseResult<number> = notParsed('type.integer');
        assert.deepStrictEqual(failure, {ok: false, messageKey: 'type.integer'});
        // a failure has no `value`, so nothing can read one out of it without checking `ok`
        // @ts-expect-error
        var noValue = failure.value;
        assert.equal(noValue, undefined);
    })
})

describe("aida behaviour", function(){
    it("covers every type aida declares", function(){
        var provider: TypeProvider<typeof typeDefs> = typeBehaviours;
        assert.deepStrictEqual(Object.keys(provider).sort(), Object.keys(typeDefs).sort());
    })
    it("reads and writes a fecha", function(){
        assert.deepStrictEqual(valueOf(typeBehaviours.fecha.parse('2026-07-15')), {año: 2026, mes: 7, día: 15});
        assert.equal(typeBehaviours.fecha.format({año: 2026, mes: 7, día: 15}), '2026-07-15');
        assert.equal(typeBehaviours.fecha.format({año: 26, mes: 1, día: 2}), '0026-01-02');
    })
    it("rejects a date with the right shape and no existence", function(){
        assert.equal(messageKeyOf(typeBehaviours.fecha.parse('2026-02-31')), 'type.date');
        assert.equal(messageKeyOf(typeBehaviours.fecha.parse('2026-13-01')), 'type.date');
        assert.equal(messageKeyOf(typeBehaviours.fecha.parse('15/07/2026')), 'type.date');
        assert.equal(messageKeyOf(typeBehaviours.fecha.parse('')), 'type.date');
    })
    it("round-trips a fecha through its text", function(){
        var text = '2026-02-29'; // 2026 is not a leap year
        assert.equal(messageKeyOf(typeBehaviours.fecha.parse(text)), 'type.date');
        var leap = '2028-02-29';
        assert.equal(typeBehaviours.fecha.format(valueOf(typeBehaviours.fecha.parse(leap))), leap);
    })
    it("types a fecha as the composite value the definition declares", function(){
        var fecha: Fecha = valueOf(typeBehaviours.fecha.parse('2026-07-15'));
        var asDeclared: {año: number, mes: number, día: number} = fecha;
        var backAgain: Fecha = asDeclared;
        assert.deepStrictEqual(backAgain, {año: 2026, mes: 7, día: 15});
        // @ts-expect-error a fecha is not a Date
        var asDate: Date = valueOf(typeBehaviours.fecha.parse('2026-07-15'));
        // @ts-expect-error nor a string
        typeBehaviours.fecha.format('2026-07-15');
        assert.ok(asDate != null);
    })
    it("specializes boolean without losing the common one", function(){
        assert.equal(valueOf(typeBehaviours.boolean.parse('sí')), true);
        assert.equal(valueOf(typeBehaviours.boolean.parse('si')), true);
        assert.equal(valueOf(typeBehaviours.boolean.parse('NO')), false);
        // what the common behaviour reads, the specialized one still reads
        assert.equal(valueOf(typeBehaviours.boolean.parse('true')), true);
        assert.equal(valueOf(typeBehaviours.boolean.parse('false')), false);
        assert.equal(messageKeyOf(typeBehaviours.boolean.parse('quizás')), 'type.boolean');
        // and it writes the same texts
        assert.equal(typeBehaviours.boolean.format(true), 'true');
    })
    it("gives email the behaviour of the type it is defined as", function(){
        // email is commonTypeDefs.text in aida: the check that it looks like an email is a
        // rule over the value, not a parse
        assert.equal(valueOf(typeBehaviours.email.parse('no-arroba')), 'no-arroba');
        assert.equal(typeBehaviours.email.parse('a@b.c').ok, true);
    })
    it("keeps the definition serializable", function(){
        // the behaviours are functions and the definition has none: it still survives JSON
        assert.deepStrictEqual(JSON.parse(JSON.stringify(typeDefs)), {
            text   : {tsType: null},
            integer: {tsType: null},
            boolean: {tsType: null},
            fecha  : {tsType: null},
            email  : {tsType: null},
        });
        assert.equal(typeof fechaBehaviour.parse, 'function');
    })
    it("resolves a behaviour by the type name a field carries", function(){
        // this is how an implementation uses it: the description says `fecha`, and that
        // string is the key into the provider
        var typeName: keyof typeof typeDefs = 'fecha';
        var behaviour = typeBehaviours[typeName];
        assert.equal(behaviour, fechaBehaviour);
        // @ts-expect-error a name that is not a type of the collection does not index it
        var missing = typeBehaviours['fechita'];
        assert.equal(missing, undefined);
    })
})

describe("a type collection with a behaviour provider", function(){
    it("admits any collection, not only aida's", function(){
        var legajo = {legajo: {tsType: 0 as number}};
        var collection: TypeCollection = legajo;
        var provider: TypeProvider<typeof legajo> = {
            legajo: {
                parse: (text) => /^\d{1,6}$/.test(text) ? parsed(Number(text)) : notParsed('type.legajo'),
                format: (value) => String(value).padStart(6, '0'),
            },
        };
        assert.equal(valueOf(provider.legajo.parse('1234')), 1234);
        assert.equal(provider.legajo.format(1234), '001234');
        assert.equal(messageKeyOf(provider.legajo.parse('1234567')), 'type.legajo');
        assert.ok(collection != null);
    })
})

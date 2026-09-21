import * as assert from "assert";

import { TypeProvider, TypeBehaviour, ParseResult, commonTypeBehaviours, parsed, notParsed,
    commonTypeDefs, TypeCollection
} from "../src/common/index";
import { aidaTypes, typeBehaviours, fechaBehaviour } from "../examples/common/index";

type Fecha = typeof aidaTypes['types']['fecha']['tsType']

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
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.text.deserialize('hola')), 'hola');
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.integer.deserialize(' 12 ')), 12);
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.integer.deserialize('-3')), -3);
        assert.deepStrictEqual(valueOf(commonTypeBehaviours.boolean.deserialize('TRUE')), true);
        assert.equal(commonTypeBehaviours.integer.serialize(12), '12');
        assert.equal(commonTypeBehaviours.boolean.serialize(false), 'false');
    })
    it("rejects what Number() would have accepted", function(){
        // Number('') is 0, Number('0x10') is 16 and Number('1.5') is 1.5: none of them is this integer
        assert.equal(messageKeyOf(commonTypeBehaviours.integer.deserialize('')), 'type.integer');
        assert.equal(messageKeyOf(commonTypeBehaviours.integer.deserialize('0x10')), 'type.integer');
        assert.equal(messageKeyOf(commonTypeBehaviours.integer.deserialize('1.5')), 'type.integer');
        assert.equal(messageKeyOf(commonTypeBehaviours.boolean.deserialize('sí')), 'type.boolean');
    })
    it("round-trips every common type", function(){
        assert.equal(commonTypeBehaviours.text.serialize(valueOf(commonTypeBehaviours.text.deserialize('x'))), 'x');
        assert.equal(commonTypeBehaviours.integer.serialize(valueOf(commonTypeBehaviours.integer.deserialize('42'))), '42');
        assert.equal(commonTypeBehaviours.boolean.serialize(valueOf(commonTypeBehaviours.boolean.deserialize('true'))), 'true');
    })
    it("types the parsed value after the type of the definition", function(){
        // the behaviour of `integer` yields a number, and that is checked in both directions
        var asNumber: number = valueOf(commonTypeBehaviours.integer.deserialize('7'));
        var asParsed: ParseResult<number> = commonTypeBehaviours.integer.deserialize('7');
        assert.equal(asNumber, 7);
        assert.equal(valueOf(asParsed), 7);
        // @ts-expect-error the parsed value of `integer` is not a string
        var asString: string = valueOf(commonTypeBehaviours.integer.deserialize('7'));
        // @ts-expect-error `format` of `integer` does not take a string either
        commonTypeBehaviours.integer.serialize('7');
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
        var ok: TypeBehaviour<string> = {deserialize: (text) => parsed(text), serialize: (value) => value, check: esTexto};
        assert.equal(valueOf(ok.deserialize('a')), 'a');
        // @ts-expect-error the parsed value has to be the type the behaviour declares
        var wrongParse: TypeBehaviour<string> = {deserialize: () => parsed(1), serialize: (value) => value, check: esTexto};
        // @ts-expect-error and `format` has to take it
        var wrongFormat: TypeBehaviour<string> = {deserialize: (text) => parsed(text), serialize: (value: number) => String(value), check: esTexto};
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

function esTexto(value: unknown): value is string { return typeof value === 'string'; }

describe("aida behaviour", function(){
    it("covers every type aida declares", function(){
        var provider: TypeProvider<typeof aidaTypes['types']> = typeBehaviours;
        assert.deepStrictEqual(Object.keys(provider).sort(), Object.keys(aidaTypes.types).sort());
    })
    it("reads and writes a fecha", function(){
        assert.ok(valueOf(typeBehaviours.fecha.deserialize('2026-07-15')).equals(Temporal.PlainDate.from('2026-07-15')));
        assert.equal(typeBehaviours.fecha.serialize(Temporal.PlainDate.from('2026-07-15')), '2026-07-15');
        assert.equal(typeBehaviours.fecha.serialize(Temporal.PlainDate.from('0026-01-02')), '0026-01-02');
    })
    it("rejects a date with the right shape and no existence", function(){
        assert.equal(messageKeyOf(typeBehaviours.fecha.deserialize('2026-02-31')), 'type.date');
        assert.equal(messageKeyOf(typeBehaviours.fecha.deserialize('2026-13-01')), 'type.date');
        assert.equal(messageKeyOf(typeBehaviours.fecha.deserialize('15/07/2026')), 'type.date');
        assert.equal(messageKeyOf(typeBehaviours.fecha.deserialize('')), 'type.date');
    })
    it("round-trips a fecha through its text", function(){
        var text = '2026-02-29'; // 2026 is not a leap year
        assert.equal(messageKeyOf(typeBehaviours.fecha.deserialize(text)), 'type.date');
        var leap = '2028-02-29';
        assert.equal(typeBehaviours.fecha.serialize(valueOf(typeBehaviours.fecha.deserialize(leap))), leap);
    })
    it("types a fecha as the value the definition declares", function(){
        var fecha: Fecha = valueOf(typeBehaviours.fecha.deserialize('2026-07-15'));
        var asDeclared: Temporal.PlainDate = fecha;
        var backAgain: Fecha = asDeclared;
        assert.equal(backAgain.year, 2026);
        assert.equal(backAgain.month, 7);
        assert.equal(backAgain.day, 15);
        // @ts-expect-error a fecha is not a Date
        var asDate: Date = valueOf(typeBehaviours.fecha.deserialize('2026-07-15'));
        // @ts-expect-error nor a string
        typeBehaviours.fecha.serialize('2026-07-15');
        assert.ok(asDate != null);
    })
    it("gives email the behaviour of the type it is defined as", function(){
        // email is commonTypeDefs.text in aida: the check that it looks like an email is a
        // rule over the value, not a parse
        assert.equal(valueOf(typeBehaviours.email.deserialize('no-arroba')), 'no-arroba');
        assert.equal(typeBehaviours.email.deserialize('a@b.c').ok, true);
    })
    it("keeps the definition serializable", function(){
        // the behaviours are functions and the definition has none: it still survives JSON
        assert.deepStrictEqual(JSON.parse(JSON.stringify(aidaTypes.types)), {
            text   : {tsType: null},
            integer: {tsType: null},
            boolean: {tsType: null},
            fecha  : {tsType: null},
            email  : {tsType: null},
        });
        assert.equal(typeof fechaBehaviour.deserialize, 'function');
    })
    it("resolves a behaviour by the type name a field carries", function(){
        // this is how an implementation uses it: the description says `fecha`, and that
        // string is the key into the provider
        var typeName: keyof typeof aidaTypes['types'] = 'fecha';
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
                deserialize: (text) => /^\d{1,6}$/.test(text) ? parsed(Number(text)) : notParsed('type.legajo'),
                serialize: (value) => String(value).padStart(6, '0'),
                check: (value): value is number => typeof value === 'number',
            },
        };
        assert.equal(valueOf(provider.legajo.deserialize('1234')), 1234);
        assert.equal(provider.legajo.serialize(1234), '001234');
        assert.equal(messageKeyOf(provider.legajo.deserialize('1234567')), 'type.legajo');
        assert.ok(collection != null);
    })
})

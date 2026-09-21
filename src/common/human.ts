import { ParseOptions, TextRecord, behaviourOf, walkTextRecord } from "./serialize";
import { Problem, ValidationResult } from "./problem";
import { RecordDef, RecordInstanceType, completeRecord } from "./ssot-record";
import { SystemTypeContext, TypeCollection } from "./ssot-types";
import { ParseResult, notParsed, parsed } from "./type-behaviour";

/* Reading and writing a value the way a person does it, which is not the way a machine does.

   The machine pair (deserialize/serialize in type-behaviour.ts) has to round-trip and has to
   be unambiguous, because it is what travels in a url, in a csv we wrote, in a string inside
   a json. This pair is the other one: what somebody types into a control and what they are
   shown back.

   They cannot be the same function, and the reason is not that one is more permissive. In
   es-AR `123.456` is a hundred and twenty-three thousand; serialized it is not even a valid
   integer. No amount of tolerance resolves that: it takes knowing the convention, and the
   convention is the locale.

   The locale is not a property of the system — the same system serves people in several —
   so it is a parameter of the call and never part of the definition. */

export type Locale = string

export type HumanBehaviour<TsType> = {
    parse: (text: string, locale: Locale) => ParseResult<TsType>
    format: (value: TsType, locale: Locale) => string
}

/* Every type may declare it, none has to: what a type does not say here is read and written
   the way it serializes, which is the right answer whenever the locale changes nothing. */
export type HumanProvider<TTypeDefs extends TypeCollection> = {
    readonly [K in keyof TTypeDefs]?: HumanBehaviour<TTypeDefs[K]['tsType']>
}

/* the bound, contravariant on format like BehaviourCollection is on serialize */
export type AnyHumanBehaviour = {
    parse: (text: string, locale: Locale) => ParseResult<unknown>
    format: (value: never, locale: Locale) => string
}

export type HumanCollection = Record<string, AnyHumanBehaviour>

function separatorOf(locale: Locale, type: 'group' | 'decimal'): string {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
    return parts.find(part => part.type === type)?.value ?? '';
}

export const commonHumanBehaviours = {
    integer: {
        parse: (text, locale) => {
            const group = separatorOf(locale, 'group');
            const clean = group === '' ? text.trim() : text.trim().split(group).join('');
            if (!/^-?\d+$/.test(clean)) return notParsed('type.integer');
            return parsed(Number(clean));
        },
        format: (value, locale) => new Intl.NumberFormat(locale).format(value),
    } satisfies HumanBehaviour<number>,
} satisfies HumanProvider<{integer: {tsType: number}}>

/* text needs nothing: a text is the same text in every locale. boolean does need it — a
   person types `sí` and not `true` — but the words are a message and messages are multilang,
   which does not exist yet; until then it falls back to the machine pair. */

/* Resolving the pair for a type: what the system declared, or the machine one, which is
   the right answer whenever the locale changes nothing about how the value reads. */
export function humanBehaviourOf(context: SystemTypeContext, typeName: string): AnyHumanBehaviour {
    const human = context.human?.[typeName];
    if (human != null) return human;
    const machine = behaviourOf(context, typeName);
    return {
        parse: (text) => machine.deserialize(text),
        format: (value) => machine.serialize(value),
    };
}

export function parseRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    locale: Locale,
    options: ParseOptions = {},
): ValidationResult<RecordInstanceType<TContext, TRecordDef>> {
    const {problems, values} = walkTextRecord(context, recordDef, text, options,
        (typeName, raw) => humanBehaviourOf(context, typeName).parse(raw, locale));
    if (problems.length > 0) return {ok: false, problems};
    return {ok: true, value: values as RecordInstanceType<TContext, TRecordDef>};
}

export function parseProblems<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    locale: Locale,
    options: ParseOptions = {},
): readonly Problem[] {
    return walkTextRecord(context, recordDef, text, options,
        (typeName, raw) => humanBehaviourOf(context, typeName).parse(raw, locale)).problems;
}

/* Field by field, like serializeFields and for the same reason: whoever builds the screen
   decides what to do with them. A null is an empty cell and not the word "null". */
export function formatFields<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    row: Readonly<Record<string, unknown>>,
    locale: Locale,
): Readonly<Record<string, string | null>> {
    const text: Record<string, string | null> = {};
    for (const [name, field] of Object.entries(completeRecord(context, recordDef))) {
        const value = row[name];
        text[name] = value == null ? null : humanBehaviourOf(context, String(field.type)).format(value as never, locale);
    }
    return text;
}

import { ParseOptions, TextRecord, walkTextRecord } from "./parse";
import { Problem, ValidationResult } from "./problem";
import { RecordDef, RecordInstanceType, completeRecord } from "./ssot-record";
import { SystemTypeContext, TypeCollection } from "./ssot-types";
import { ParseResult, notParsed, parsed } from "./type-behaviour";

/* Reading and writing a value the way a person does it, which is not the way a machine does.

   The canonical pair (parse/format in type-behaviour.ts) has to round-trip and has to be
   unambiguous, because it is what travels in a url, in a csv we wrote, in a string inside a
   json. This pair is the other one: what somebody types into a control and what they are
   shown back.

   They cannot be the same function, and the reason is not that one is more permissive. In
   es-AR `123.456` is a hundred and twenty-three thousand; in the canonical form it is not
   even a valid integer. No amount of tolerance resolves that: it takes knowing the
   convention, and the convention is the locale.

   The locale is not a property of the system — the same system serves people in several —
   so it is a parameter of the call and never part of the definition. */

export type Locale = string

export type HumanBehaviour<TsType> = {
    read: (text: string, locale: Locale) => ParseResult<TsType>
    display: (value: TsType, locale: Locale) => string
}

/* Every type may declare it, none has to: what a type does not say is read and written the
   canonical way, which is the right answer whenever the locale changes nothing. */
export type HumanProvider<TTypeDefs extends TypeCollection> = {
    readonly [K in keyof TTypeDefs]?: HumanBehaviour<TTypeDefs[K]['tsType']>
}

/* the bound, contravariant on display like BehaviourCollection is on format */
export type AnyHumanBehaviour = {
    read: (text: string, locale: Locale) => ParseResult<unknown>
    display: (value: never, locale: Locale) => string
}

export type HumanCollection = Record<string, AnyHumanBehaviour>

function separatorOf(locale: Locale, type: 'group' | 'decimal'): string {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.8);
    return parts.find(part => part.type === type)?.value ?? '';
}

export const commonHumanBehaviours = {
    integer: {
        read: (text, locale) => {
            const group = separatorOf(locale, 'group');
            const clean = group === '' ? text.trim() : text.trim().split(group).join('');
            if (!/^-?\d+$/.test(clean)) return notParsed('type.integer');
            return parsed(Number(clean));
        },
        display: (value, locale) => new Intl.NumberFormat(locale).format(value),
    } satisfies HumanBehaviour<number>,
} satisfies HumanProvider<{integer: {tsType: number}}>

/* text needs nothing: a text is the same text in every locale. boolean does need it — a
   person types `sí` and not `true` — but the words are a message and messages are multilang,
   which does not exist yet; until then it falls back to the canonical pair. */

/* Resolving the pair for a type: what the system declared, or the canonical one, which is
   the right answer whenever the locale changes nothing about how the value reads. */
export function humanBehaviourOf(context: SystemTypeContext, typeName: string): AnyHumanBehaviour {
    const human = context.human?.[typeName];
    if (human != null) return human;
    const canonical = context.behaviours[typeName];
    if (canonical == null) {
        throw new Error('no behaviour declared for type "' + typeName + '" in this system');
    }
    return {
        read: (text) => canonical.parse(text),
        display: (value) => canonical.format(value),
    };
}

/* The same as parseRecord, in the convention a person writes. Two functions and not an option
   of one, because the one that reads a url and the one that reads a form are not the same
   thing said differently: they disagree about what `123.456` means. */
export function readRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    locale: Locale,
    options: ParseOptions = {},
): ValidationResult<RecordInstanceType<TContext, TRecordDef>> {
    const {problems, values} = walkTextRecord(context, recordDef, text, options,
        (typeName, raw) => humanBehaviourOf(context, typeName).read(raw, locale));
    if (problems.length > 0) return {ok: false, problems};
    return {ok: true, value: values as RecordInstanceType<TContext, TRecordDef>};
}

export function readProblems<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    text: TextRecord,
    locale: Locale,
    options: ParseOptions = {},
): readonly Problem[] {
    return walkTextRecord(context, recordDef, text, options,
        (typeName, raw) => humanBehaviourOf(context, typeName).read(raw, locale)).problems;
}

/* Los campos del record, cada uno como el texto que la persona ve. No se llama displayRecord
   porque no despliega el registro: despliega cada uno de sus campos, y quien arma la pantalla
   decide qué hace con ellos. Un null es una celda vacía y no la palabra "null". */
export function displayFields<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    recordDef: TRecordDef,
    row: Readonly<Record<string, unknown>>,
    locale: Locale,
): Readonly<Record<string, string | null>> {
    const text: Record<string, string | null> = {};
    for (const [name, field] of Object.entries(completeRecord(context, recordDef))) {
        const value = row[name];
        text[name] = value == null ? null : humanBehaviourOf(context, String(field.type)).display(value as never, locale);
    }
    return text;
}

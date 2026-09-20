import { TypeCollection, commonTypeDefs } from "./ssot-types";

/* The behaviour of a domain type: turning text into a value of that type and back.

   It lives here, next to the definition of the types, and not in each implementation.
   A description says that a field is a `fecha`; what a `fecha` reads like and writes like
   is part of what a `fecha` IS, so an implementation that had to write it again would be
   writing a piece of the truth that this module is supposed to be the single source of —
   and the next implementation would write it differently.

   The rule that descriptions are serializable is not broken by this: a `TypeDef` still
   carries no functions. This module is the separate registry that the rule assumes
   ("special behaviours are referenced by name and resolved against implementations
   registered apart"), and the name a description carries is the key into it.

   Text, and not any other interchange format, because text is what every boundary outside
   the domain already carries: an http body, a url parameter, a form input, a csv cell. */

export type ParseResult<TsType> =
    | {ok: true, value: TsType}
    | {ok: false, messageKey: string}

export type TypeBehaviour<TsType> = {
    parse: (text: string) => ParseResult<TsType>
    format: (value: TsType) => string
    /* parse reads a text; check looks at a value that is already built and says whether it is
       one of these. It is what lets a record that did not come through the parser — the
       parameters of a procedure, a row handed over by somebody else — be typed against the
       definition instead of trusted. */
    check: (value: unknown) => value is TsType
}

/* Exhaustive by construction: a type added to the collection without its behaviour does
   not compile. */
export type TypeProvider<TTypeDefs extends TypeCollection> = {
    readonly [K in keyof TTypeDefs]: TypeBehaviour<TTypeDefs[K]['tsType']>
}

/* the bound for "the behaviour of any type at all", the counterpart of FieldCompleter and for
   the same reason: format takes the value, and a parameter is contravariant, so the widest
   collection is the one whose format takes never. Declared this way, the behaviour of every
   concrete type fits the bound. */
export type AnyTypeBehaviour = {
    parse: (text: string) => ParseResult<unknown>
    format: (value: never) => string
    check: (value: unknown) => boolean
}

export type BehaviourCollection = Record<string, AnyTypeBehaviour>

export function parsed<TsType>(value: TsType): ParseResult<TsType> {
    return {ok: true, value};
}

/* A failure carries the message key, never a text: the wording is resolved where the
   language is known. */
export function notParsed<TsType>(messageKey: string): ParseResult<TsType> {
    return {ok: false, messageKey};
}

export const commonTypeBehaviours: TypeProvider<typeof commonTypeDefs> = {
    text: {
        parse: (text) => parsed(text),
        format: (value) => value,
        check: (value): value is string => typeof value === 'string',
    },
    integer: {
        /* Number() accepts '', ' 12 ' and '0x10'; the regular expression lets through only
           what an integer is */
        parse: (text) => {
            if (!/^-?\d+$/.test(text.trim())) return notParsed('type.integer');
            return parsed(Number(text.trim()));
        },
        format: (value) => String(value),
        check: (value): value is number => typeof value === 'number' && Number.isInteger(value),
    },
    boolean: {
        parse: (text) => {
            const normalized = text.trim().toLowerCase();
            if (normalized === 'true') return parsed(true);
            if (normalized === 'false') return parsed(false);
            return notParsed('type.boolean');
        },
        format: (value) => value ? 'true' : 'false',
        check: (value): value is boolean => typeof value === 'boolean',
    },
}

import { TypeCollection, commonTypeDefs } from "./system-design";

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
}

/* Exhaustive by construction: a type added to the collection without its behaviour does
   not compile. */
export type TypeProvider<TTypeDefs extends TypeCollection> = {
    readonly [K in keyof TTypeDefs]: TypeBehaviour<TTypeDefs[K]['tsType']>
}

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
    },
    integer: {
        /* Number() accepts '', ' 12 ' and '0x10'; the regular expression lets through only
           what an integer is */
        parse: (text) => {
            if (!/^-?\d+$/.test(text.trim())) return notParsed('type.integer');
            return parsed(Number(text.trim()));
        },
        format: (value) => String(value),
    },
    boolean: {
        parse: (text) => {
            const normalized = text.trim().toLowerCase();
            if (normalized === 'true') return parsed(true);
            if (normalized === 'false') return parsed(false);
            return notParsed('type.boolean');
        },
        format: (value) => value ? 'true' : 'false',
    },
}

/* the record: a map of fields, the fundamental element of the SSOT. It stands on its own,
   without entities or database: it also describes a payload or the parameters of an endpoint. */

import { SystemTypeContext } from "./ssot-types";

export type FieldDef<TContext extends SystemTypeContext> = {
    type: keyof TContext['types']
    isName?: true
    nullable?: boolean
    label?: string
    description?: string
}

export type FieldInfo<TContext extends SystemTypeContext> = Required<Omit<FieldDef<TContext>, 'isName'>> & {isName: boolean}

export type RecordDef<TContext extends SystemTypeContext> = Record<string, FieldDef<TContext>>

// export type RecordInfo<TContext extends SystemTypeContext> = Required<RecordDef<TContext>>
export type RecordInfo<TContext extends SystemTypeContext> = Record<string, FieldInfo<TContext>>

export type RecordInfoOf<TRecordDef extends RecordDef<SystemTypeContext>> = {
    [K in keyof TRecordDef]: Omit<FieldInfo<SystemTypeContext>, 'type' | 'nullable'> & {
        type: TRecordDef[K]['type']
        // what is known statically is only the explicit nullable:false; the default stays boolean
        nullable: TRecordDef[K] extends {nullable: false} ? false : boolean
    }
}

export function completeRecord<TRecordDef extends RecordDef<SystemTypeContext>>(recordDef: TRecordDef): RecordInfoOf<TRecordDef>{
    return Object.fromEntries(Object.entries(recordDef).map(([name, fieldDef]) => ([name, {
        // @ts-expect-error type is specified because we need to guaranty the order in the completed type
        type: null,
        isName: false,
        nullable: true,
        label: name.replace(/_/g,' '),
        description: '',
        ...fieldDef,
    }]))) as RecordInfoOf<TRecordDef>;
}

/* the fields default to nullable (that is the default completeRecord writes into the Info),
   so only the ones explicitly marked nullable:false stay free of null */
export type NullPart<TFieldDef> = TFieldDef extends {nullable: false} ? never : null

export type RecordInstanceType<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>> = {
    [K in keyof TRecordDef]: TContext['types'][TRecordDef[K]['type']]['tsType'] | NullPart<TRecordDef[K]>
}

/* marking a subset of the fields as not nullable is a record operation, but which subset it is
   the record does not know: the entity level is the one that says it (its pk) */
export type NotNullableFieldsOf<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>, TNames extends string> = {
    [K in keyof TRecordDef]: K extends TNames ? TRecordDef[K] & {nullable: false} : TRecordDef[K]
}

export function notNullableFields(fields: RecordDef<SystemTypeContext>, names: readonly string[]): RecordDef<SystemTypeContext> {
    return Object.fromEntries(Object.entries(fields).map(([name, fieldDef]) =>
        [name, names.includes(name) ? {...fieldDef, nullable: false} : fieldDef]
    ));
}

/* a record def only means something against a context: which types exist is not something the
   def can say by itself. recordDef checks it against the context and gives back the very same
   def: what it adds is the check and the preserved literals, not a wrapper. Unlike a satisfies,
   the constraint of a type parameter does no excess property check, so a system can put its own
   properties in a field (a width, a tooltip) without redeclaring a wider FieldDef.
   It does not complete anything: the def is worth having as it is (one def is written in terms
   of another), and every end knows how to complete it when it needs to. */
export function recordDef<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    _context: TContext,
    def: TRecordDef,
): TRecordDef {
    return def;
}

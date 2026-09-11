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

export function notNullableFields(recordDef: RecordDef<SystemTypeContext>, names: readonly string[]): RecordDef<SystemTypeContext> {
    return Object.fromEntries(Object.entries(recordDef).map(([name, fieldDef]) =>
        [name, names.includes(name) ? {...fieldDef, nullable: false} : fieldDef]
    ));
}

/* a record def only means something against a context: which types exist is not something the
   def can say by itself. createRecordSsot binds the two without merging them: what travels as
   JSON is the def, and the context is what both ends of the serialization have to share.
   It does not complete anything: the def is worth having as it is (one def is written in terms
   of another), and every end knows how to complete it when it needs to. */
export type RecordSsot<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>> = {
    context: TContext
    def: TRecordDef
}

export function createRecordSsot<TContext extends SystemTypeContext, const TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    def: TRecordDef,
): RecordSsot<TContext, TRecordDef> {
    return {context, def};
}

/* the def goes in as it is: intersecting it with RecordDef to "help" the constraint drags in the
   index signature of the Record, and then the deduced instance type accepts any field name */
export type RecordInstanceTypeOf<TRecordSsot extends RecordSsot<SystemTypeContext, RecordDef<SystemTypeContext>>> =
    RecordInstanceType<TRecordSsot['context'], TRecordSsot['def']>

/* the record: a map of fields, the fundamental element of the SSOT. It stands on its own,
   without entities or database: it also describes a payload or the parameters of an endpoint. */

import { AnyFieldDef, CoreFieldDef, SystemTypeContext, TypeCollection } from "./ssot-types";

/* the field def and the field info are the two ends of the system's own completer: what it
   takes and what it gives back. The framework only adds the core it needs to read itself. */
export type FieldDef<TContext extends SystemTypeContext> = Parameters<TContext['completeField']>[0]

export type FieldInfo<TContext extends SystemTypeContext> = ReturnType<TContext['completeField']>

export type RecordDef<TContext extends SystemTypeContext> = Record<string, FieldDef<TContext>>

export type RecordInfo<TContext extends SystemTypeContext> = Record<string, FieldInfo<TContext>>

export type AnyRecordDef = Record<string, AnyFieldDef>

/* the name of the type of a field, read out of a def the framework cannot see inside: the
   field def is the system's, and defineTypes is what guarantees it carries the core. Reaching
   it by intersecting with CoreFieldDef does not work: an intersection in the contextual
   position widens the literal of type back to the whole union of names. */
export type TypeNameOf<TContext extends SystemTypeContext, TFieldDef> =
    TFieldDef extends {type: infer TName extends keyof TContext['types']} ? TName : never

/* the keys that the system's field def does not declare are typed never, so any real value
   put in them fails to compile. It is needed because the constraint of a type parameter does
   no excess property check, and without this a typo in `label` would silently become a new
   property that nothing reads. */
export type ExactFieldsOf<TRecordDef, TFieldDef> = {
    [K in keyof TRecordDef]: Record<Exclude<keyof TRecordDef[K], keyof TFieldDef>, never>
}

/* a record def only means something against a context: which types exist is not something the
   def can say by itself. defineRecord checks it against the context and gives back the very same
   def: what it adds is the check and the preserved literals, not a wrapper. A system that wants
   its own properties in a field (a width, a tooltip) declares them in its own field def, which
   is the one the context carries: what nobody declared is rejected.
   It does not complete anything: the def is worth having as it is (one def is written in terms
   of another), and every end knows how to complete it when it needs to.
   The field def is inferred from the context's completer instead of being read with
   FieldDef<TContext>: through that deferred indexed access the compiler cannot see that the
   target of `type` is a union of literals, and widens every one of them to the whole union. */
export function defineRecord<
    TTypes extends TypeCollection,
    TFieldDef extends CoreFieldDef<TTypes>,
    TRecordDef extends Record<string, TFieldDef>,
>(
    _context: {types: TTypes, completeField: (fieldDef: TFieldDef, name: string) => object},
    def: TRecordDef & ExactFieldsOf<TRecordDef, TFieldDef>,
): TRecordDef {
    return def;
}

/* the Info of a concrete def: the shape comes from the system's completer, but type and
   nullable are pinned to what this def actually says, which is what the generators read */
export type RecordInfoOf<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>> = {
    [K in keyof TRecordDef]: Omit<FieldInfo<TContext>, 'name' | 'type' | 'nullable'> & {
        name: K
        type: TypeNameOf<TContext, TRecordDef[K]>
        // what is known statically is only the explicit nullable:false; the default stays boolean
        nullable: TRecordDef[K] extends {nullable: false} ? false : boolean
    }
}

/* completing knows no defaults of its own: it hands each field to the system's completer,
   with its name, because some defaults are derived from it */
export function completeRecord<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>>(
    context: TContext,
    fields: TRecordDef,
): RecordInfoOf<TContext, TRecordDef> {
    return Object.fromEntries(Object.entries(fields).map(([name, fieldDef]) =>
        [name, context.completeField(fieldDef as never, name)]
    )) as RecordInfoOf<TContext, TRecordDef>;
}

/* a field admits null unless it says nullable:false, so only that one stays free of null */
export type NullPart<TFieldDef> = TFieldDef extends {nullable: false} ? never : null

export type RecordInstanceType<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>> = {
    [K in keyof TRecordDef]: TContext['types'][TypeNameOf<TContext, TRecordDef[K]>]['tsType'] | NullPart<TRecordDef[K]>
}

/* marking a subset of the fields as not nullable is a record operation, but which subset it is
   the record does not know: the entity level is the one that says it (its pk) */
export type NotNullableFieldsOf<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>, TNames extends string> = {
    [K in keyof TRecordDef]: K extends TNames ? TRecordDef[K] & {nullable: false} : TRecordDef[K]
}

export function notNullableFields(fields: AnyRecordDef, names: readonly string[]): AnyRecordDef {
    return Object.fromEntries(Object.entries(fields).map(([name, fieldDef]) =>
        [name, names.includes(name) ? {...fieldDef, nullable: false} : fieldDef]
    ));
}

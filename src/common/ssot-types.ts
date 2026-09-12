/* the types a system is described with. Each system defines its own (Edad, Legajo): the
   framework only provides the mechanism and a handful of common ones. */

export const boxType = <T>() => null as T

/* tsType is a phantom: boxType carries a compile-time type in a value that is null at runtime.
   The parameter was never instantiated with anything (only TypeDef<any>), because the precise
   type of each one comes from the literal that the satisfies preserves, not from the parameter. */
export interface TypeDef {
    tsType: unknown
}

export type TypeCollection = Record<string, TypeDef>

/* what the SSOT itself needs to know about a field, and nothing else: the type, to deduce the
   instance type, and whether it admits null. Everything else a field may carry — a label, a
   description, which field names the row, a default value, a width for the grid — belongs to
   the system, which declares its own field def on top of this one. */
export type CoreFieldDef<TTypes extends TypeCollection> = {
    type: keyof TTypes
    nullable?: boolean
}

/* the info carries the name, which the def does not: the def is written inside a map, where
   the key already says it, but the info is a derived value and a derived value is worth having
   self-describing. That is also what allows serializing a map of infos as an ARRAY, which is the
   only way to guarantee the order to a system that does not share the key-order rules of JS.
   It is a denormalization, but a safe one: the framework writes it from the key, not the human. */
export type CoreFieldInfo<TTypes extends TypeCollection> = {
    name: string
    type: keyof TTypes
    nullable: boolean
}

/* completing a field def is behaviour, so it lives in the context and not in the def: the
   defaults are the system's decision, not the framework's. The name comes in because some
   defaults are derived from it (the label). Declaring the parameter as never makes this a
   supertype of every unary completer, so any system's own field def fits the bound. */
export type FieldCompleter = (fieldDef: never, name: string) => object

export type SystemTypeContext = {
    types: TypeCollection
    completeField: FieldCompleter
}

/* the gate where a system's own field def and completer are checked against its types:
   the def has to carry at least the core, and the completed info has to fill it in */
export function defineTypes<
    const TTypes extends TypeCollection,
    TFieldDef extends CoreFieldDef<TTypes>,
    TFieldInfo extends CoreFieldInfo<TTypes>,
>(
    context: {types: TTypes, completeField: (fieldDef: TFieldDef, name: string) => TFieldInfo}
): {types: TTypes, completeField: (fieldDef: TFieldDef, name: string) => TFieldInfo} {
    return context;
}

/* the bound for "a field def of any system at all". It is NOT FieldDef<SystemTypeContext>:
   the field def is the parameter of the completer, and a parameter is contravariant, so the
   widest context yields the narrowest (never) field def. */
export type AnyFieldDef = {
    type: string
    nullable?: boolean
}

export const commonTypeDefs = {
    text       : {tsType: boxType<string>()},
    integer    : {tsType: boxType<number>()},
    boolean    : {tsType: boxType<boolean>()},
} satisfies TypeCollection;

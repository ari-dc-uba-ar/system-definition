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

/* every layer of the SSOT takes exactly one type parameter: the context of the system being
   described. Each layer declares the part of the context it needs, and the outer layers extend
   the inner ones, so a system defines its context once and passes the same one to all of them. */
export type SystemTypeContext = {types: TypeCollection}

export const commonTypeDefs = {
    text       : {tsType: boxType<string>()},
    integer    : {tsType: boxType<number>()},
    boolean    : {tsType: boxType<boolean>()},
} satisfies TypeCollection;

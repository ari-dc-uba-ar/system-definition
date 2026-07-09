export const boxType = <T>() => null as T

export interface TypeDef<TsType> {
    tsType: TsType
}

export type TypeCollection = Record<string , TypeDef<any>>

export const commonTypeDefs = {
    text       : {tsType: boxType<string>()},
    integer    : {tsType: boxType<number>()},
    boolean    : {tsType: boxType<boolean>()},
} satisfies TypeCollection;

export type RecordDef<TypeDefs extends TypeCollection = typeof commonTypeDefs> = {
    type: keyof TypeDefs
    label?: string
    nullable?: boolean
    description?: string
}

export type RecordInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Required<RecordDef<TypeDefs>>

export type RecordInstanceType<TTypeCollection extends TypeCollection, TRecordDef extends Record<string,RecordDef<TTypeCollection>>> = {
    [K in keyof TRecordDef]: TTypeCollection[TRecordDef[K]['type']]['tsType']
}

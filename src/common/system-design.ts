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

export type FieldDef<TypeDefs extends TypeCollection = typeof commonTypeDefs> = {
    type: keyof TypeDefs
    label?: string
    nullable?: boolean
    description?: string
}

export type FieldInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Required<FieldDef<TypeDefs>>

export type RecordDef<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Record<string, FieldDef<TypeDefs>>

// export type RecordInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Required<RecordDef<TypeDefs>>
export type RecordInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Record<string, FieldInfo<TypeDefs>>

export type RecordInfoOf<TRecordDef extends RecordDef<TypeCollection>> = {
    [K in keyof TRecordDef]: FieldInfo<TypeCollection> & {type: TRecordDef[K]['type']}
}

export function completeRecord<TRecordDef extends RecordDef<TypeCollection>>(recordDef: TRecordDef): RecordInfoOf<TRecordDef>{
    return Object.fromEntries(Object.entries(recordDef).map(([name, fieldDef]) => ([name, {
        ...fieldDef,
        label: fieldDef.label ?? name.replace(/_/g,' '),
        nullable: fieldDef.nullable ?? true,
        description: fieldDef.description ?? '',
    }]))) as RecordInfoOf<TRecordDef>;
}

export type RecordInstanceType<TTypeCollection extends TypeCollection, TRecordDef extends RecordDef<TTypeCollection>> = {
    [K in keyof TRecordDef]: TTypeCollection[TRecordDef[K]['type']]['tsType']
}


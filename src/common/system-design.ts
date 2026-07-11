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
    isName?: true
    nullable?: boolean
    label?: string
    description?: string
}

export type FieldInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Required<Omit<FieldDef<TypeDefs>, 'isName'>> & {isName: boolean}

export type RecordDef<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Record<string, FieldDef<TypeDefs>>

// export type RecordInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Required<RecordDef<TypeDefs>>
export type RecordInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = Record<string, FieldInfo<TypeDefs>>

export type RecordInfoOf<TRecordDef extends RecordDef<TypeCollection>> = {
    [K in keyof TRecordDef]: FieldInfo<TypeCollection> & {type: TRecordDef[K]['type']}
}

export function completeRecord<TRecordDef extends RecordDef<TypeCollection>>(recordDef: TRecordDef): RecordInfoOf<TRecordDef>{
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

export type RecordInstanceType<TTypeCollection extends TypeCollection, TRecordDef extends RecordDef<TTypeCollection>> = {
    [K in keyof TRecordDef]: TTypeCollection[TRecordDef[K]['type']]['tsType']
}

/* fks reference the target entity BY NAME (a string, not the object): that keeps the defs
   serializable and makes circular and reflexive fks representable. The counterpart is that
   the target side can only be checked at the system level: see defineEntities. */
export type FkDef = {
    entity: string
    fields: readonly string[] | Readonly<Record<string, string>>
}

export type EntityDef<TypeDefs extends TypeCollection = typeof commonTypeDefs> = {
    pk: readonly string[]
    fields: RecordDef<TypeDefs>
    uks?: Readonly<Record<string, readonly string[]>>
    fks?: Readonly<Record<string, FkDef>>
}

export function defineEntity<
    const TPk extends readonly (keyof TFields & string)[],
    const TFields extends RecordDef<TypeCollection>,
    const TUks extends Readonly<Record<string, readonly (keyof TFields & string)[]>> = {},
    const TFks extends Readonly<Record<string, {entity: string, fields: readonly (keyof TFields & string)[] | {readonly [K in keyof TFields]?: string}}>> = {},
>(
    entityDef: {pk: TPk, fields: TFields, uks?: TUks, fks?: TFks}
): {pk: TPk, fields: TFields, uks: TUks, fks: TFks} {
    return {
        pk: entityDef.pk,
        fields: entityDef.fields,
        uks: entityDef.uks ?? {} as TUks,
        fks: entityDef.fks ?? {} as TFks,
    };
}

export type PkFieldsOf<TEntityDef extends EntityDef<TypeCollection>> =
    Pick<TEntityDef['fields'], TEntityDef['pk'][number] & keyof TEntityDef['fields']>

export function extractPk<TEntityDef extends EntityDef<TypeCollection>>(entityDef: TEntityDef): PkFieldsOf<TEntityDef> {
    const fields: RecordDef<TypeCollection> = entityDef.fields;
    return Object.fromEntries(entityDef.pk.map(name => [name, fields[name]])) as PkFieldsOf<TEntityDef>;
}

type FlattenPks<TPks extends readonly (readonly string[])[]> =
    TPks extends readonly [infer THead extends readonly string[], ...infer TRest extends readonly (readonly string[])[]]
        ? readonly [...THead, ...FlattenPks<TRest>]
        : readonly []

type DedupPk<TPk extends readonly string[], TSeen extends string = never> =
    TPk extends readonly [infer THead extends string, ...infer TRest extends readonly string[]]
        ? THead extends TSeen
            ? DedupPk<TRest, TSeen>
            : readonly [THead, ...DedupPk<TRest, TSeen | THead>]
        : readonly []

export type MergedPk<TPks extends readonly (readonly string[])[]> = DedupPk<FlattenPks<TPks>>

export function mergePk<const TPks extends readonly (readonly string[])[]>(...pks: TPks): MergedPk<TPks> {
    const merged: string[] = [];
    for (const pk of pks) {
        for (const name of pk) {
            if (!merged.includes(name)) merged.push(name);
        }
    }
    return merged as unknown as MergedPk<TPks>;
}

/* the Info side of an entity: everything explicit, and in only one form. The fks lose the
   array shorthand: fields is always the source → target map. The pk is deduplicated, so
   overlapping pks can be spread in the Def without mergePk. */
export type FkInfo = {
    entity: string
    fields: Readonly<Record<string, string>>
}

export type FkInfoOf<TFk extends FkDef> = {
    entity: TFk['entity']
    fields: TFk['fields'] extends readonly (infer TNames extends string)[] ? {[K in TNames]: K} : TFk['fields']
}

export type EntityInfo<TypeDefs extends TypeCollection = typeof commonTypeDefs> = {
    pk: readonly string[]
    uks: Readonly<Record<string, readonly string[]>>
    fks: Readonly<Record<string, FkInfo>>
    fields: RecordInfo<TypeDefs>
}

export type EntityInfoOf<TEntityDef extends EntityDef<TypeCollection>> = {
    pk: DedupPk<TEntityDef['pk']>
    uks: TEntityDef['uks'] extends Readonly<Record<string, readonly string[]>> ? TEntityDef['uks'] : {}
    fks: TEntityDef['fks'] extends Readonly<Record<string, FkDef>>
        ? {[F in keyof TEntityDef['fks']]: FkInfoOf<TEntityDef['fks'][F]>}
        : {}
    fields: RecordInfoOf<TEntityDef['fields']>
}

function completeFk(fkDef: FkDef): FkInfo {
    return {
        entity: fkDef.entity,
        fields: Array.isArray(fkDef.fields)
            ? Object.fromEntries(fkDef.fields.map(name => [name, name]))
            : fkDef.fields,
    };
}

export function completeEntity<const TEntityDef extends EntityDef<TypeCollection>>(entityDef: TEntityDef): EntityInfoOf<TEntityDef> {
    return {
        pk: mergePk(entityDef.pk),
        uks: entityDef.uks ?? {},
        fks: Object.fromEntries(Object.entries(entityDef.fks ?? {}).map(([name, fkDef]) => [name, completeFk(fkDef)])),
        fields: completeRecord(entityDef.fields),
    } as EntityInfoOf<TEntityDef>;
}

type SameKeySet<TA extends string, TB extends string> = [TA] extends [TB] ? ([TB] extends [TA] ? true : false) : false

type FkTargetFields<TFk extends FkDef> =
    TFk['fields'] extends readonly string[] ? TFk['fields'][number]
    : TFk['fields'] extends Readonly<Record<string, string>> ? TFk['fields'][keyof TFk['fields']]
    : never

type FkMatchesTargetKey<TFk extends FkDef, TTarget extends EntityDef<TypeCollection>> =
    SameKeySet<FkTargetFields<TFk>, TTarget['pk'][number]> extends true ? true
    : true extends {[U in keyof NonNullable<TTarget['uks']>]: SameKeySet<FkTargetFields<TFk>, NonNullable<TTarget['uks']>[U][number]>}[keyof NonNullable<TTarget['uks']>] ? true
    : false

type ValidatedFks<TFks extends Readonly<Record<string, FkDef>>, TEntities extends Readonly<Record<string, EntityDef<TypeCollection>>>> = {
    [F in keyof TFks]: TFks[F]['entity'] extends keyof TEntities
        ? FkMatchesTargetKey<TFks[F], TEntities[TFks[F]['entity'] & keyof TEntities]> extends true
            ? TFks[F]
            : never
        : never
}

export type ValidatedEntities<TEntities extends Readonly<Record<string, EntityDef<TypeCollection>>>> = {
    [E in keyof TEntities]: {fks?: ValidatedFks<NonNullable<TEntities[E]['fks']>, TEntities>}
}

/* system-level checks, where all the entities are known: every fk must point to an entity
   of the system, and its target fields must be the complete pk or one of the uks of it */
export function defineEntities<const TEntities extends Readonly<Record<string, EntityDef<TypeCollection>>>>(
    entityDefs: TEntities & ValidatedEntities<TEntities>
): TEntities {
    return entityDefs;
}


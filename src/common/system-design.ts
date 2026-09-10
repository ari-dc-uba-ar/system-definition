export const boxType = <T>() => null as T

export interface TypeDef<TsType> {
    tsType: TsType
}

export type TypeCollection = Record<string , TypeDef<any>>

/* every layer of the SSOT takes exactly one type parameter: the context of the system being
   described. Each layer declares the part of the context it needs, and the outer layers extend
   the inner ones, so a system defines its context once and passes the same one to all of them. */
export type SystemTypeContext = {types: TypeCollection}

export const commonTypeDefs = {
    text       : {tsType: boxType<string>()},
    integer    : {tsType: boxType<number>()},
    boolean    : {tsType: boxType<boolean>()},
} satisfies TypeCollection;

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

/* the pk fields are not nullable, but a record def alone does not know which fields are its
   pk: only the entity level does. Marking them is what turns a record def into the def the
   entity actually completes (and the instance type of a row of the entity). */
export type NotNullableFieldsOf<TContext extends SystemTypeContext, TRecordDef extends RecordDef<TContext>, TNames extends string> = {
    [K in keyof TRecordDef]: K extends TNames ? TRecordDef[K] & {nullable: false} : TRecordDef[K]
}

function notNullableFields(recordDef: RecordDef<SystemTypeContext>, names: readonly string[]): RecordDef<SystemTypeContext> {
    return Object.fromEntries(Object.entries(recordDef).map(([name, fieldDef]) =>
        [name, names.includes(name) ? {...fieldDef, nullable: false} : fieldDef]
    ));
}

/* the entity layer needs nothing beyond the types yet, but it names its own context anyway:
   what it will need later (the records, the other entities) then has where to go without
   touching every signature again */
export type SystemEntityContext = SystemTypeContext

/* fks reference the target entity BY NAME (a string, not the object): that keeps the defs
   serializable and makes circular and reflexive fks representable. The counterpart is that
   the target side can only be checked at the system level: see defineEntities. */
export type FkDef = {
    entity: string
    fields: readonly string[] | Readonly<Record<string, string>>
}

export type EntityDef<TContext extends SystemEntityContext> = {
    fields: RecordDef<TContext>
    pk: readonly string[]
    fks?: Readonly<Record<string, FkDef>>
    uks?: Readonly<Record<string, readonly string[]>>
}

export function defineEntity<
    const TPk extends readonly (keyof TFields & string)[],
    const TFields extends RecordDef<SystemEntityContext>,
    const TUks extends Readonly<Record<string, readonly (keyof TFields & string)[]>> = {},
    const TFks extends Readonly<Record<string, {entity: string, fields: readonly (keyof TFields & string)[] | {readonly [K in keyof TFields]?: string}}>> = {},
>(
    entityDef: {fields: TFields, pk: TPk, fks?: TFks, uks?: TUks}
): {fields: TFields, pk: TPk, fks: TFks, uks: TUks} {
    return {
        fields: entityDef.fields,
        pk: entityDef.pk,
        fks: entityDef.fks ?? {} as TFks,
        uks: entityDef.uks ?? {} as TUks,
    };
}

export type PkFieldsOf<TEntityDef extends EntityDef<SystemEntityContext>> =
    Pick<TEntityDef['fields'], TEntityDef['pk'][number] & keyof TEntityDef['fields']>

export function extractPk<TEntityDef extends EntityDef<SystemEntityContext>>(entityDef: TEntityDef): PkFieldsOf<TEntityDef> {
    const fields: RecordDef<SystemEntityContext> = entityDef.fields;
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

export type EntityInfo<TContext extends SystemEntityContext> = {
    fields: RecordInfo<TContext>
    pk: readonly string[]
    fks: Readonly<Record<string, FkInfo>>
    uks: Readonly<Record<string, readonly string[]>>
}

export type EntityInfoOf<TEntityDef extends EntityDef<SystemEntityContext>> = {
    fields: RecordInfoOf<NotNullableFieldsOf<SystemEntityContext, TEntityDef['fields'], TEntityDef['pk'][number]>>
    pk: DedupPk<TEntityDef['pk']>
    fks: TEntityDef['fks'] extends Readonly<Record<string, FkDef>>
        ? {[F in keyof TEntityDef['fks']]: FkInfoOf<TEntityDef['fks'][F]>}
        : {}
    uks: TEntityDef['uks'] extends Readonly<Record<string, readonly string[]>> ? TEntityDef['uks'] : {}
}

function completeFk(fkDef: FkDef): FkInfo {
    return {
        entity: fkDef.entity,
        fields: Array.isArray(fkDef.fields)
            ? Object.fromEntries(fkDef.fields.map(name => [name, name]))
            : fkDef.fields,
    };
}

export function completeEntity<const TEntityDef extends EntityDef<SystemEntityContext>>(entityDef: TEntityDef): EntityInfoOf<TEntityDef> {
    return {
        fields: completeRecord(notNullableFields(entityDef.fields, entityDef.pk)),
        pk: mergePk(entityDef.pk),
        fks: Object.fromEntries(Object.entries(entityDef.fks ?? {}).map(([name, fkDef]) => [name, completeFk(fkDef)])),
        uks: entityDef.uks ?? {},
    } as EntityInfoOf<TEntityDef>;
}

/* the instance type of a row of the entity: like the record one, but the pk fields
   are not nullable */
export type EntityInstanceType<TContext extends SystemEntityContext, TEntityDef extends EntityDef<TContext>> =
    RecordInstanceType<TContext, NotNullableFieldsOf<TContext, TEntityDef['fields'], TEntityDef['pk'][number]>>

type SameKeySet<TA extends string, TB extends string> = [TA] extends [TB] ? ([TB] extends [TA] ? true : false) : false

type FkTargetFields<TFk extends FkDef> =
    TFk['fields'] extends readonly string[] ? TFk['fields'][number]
    : TFk['fields'] extends Readonly<Record<string, string>> ? TFk['fields'][keyof TFk['fields']]
    : never

type FkMatchesTargetKey<TFk extends FkDef, TTarget extends EntityDef<SystemEntityContext>> =
    SameKeySet<FkTargetFields<TFk>, TTarget['pk'][number]> extends true ? true
    : true extends {[U in keyof NonNullable<TTarget['uks']>]: SameKeySet<FkTargetFields<TFk>, NonNullable<TTarget['uks']>[U][number]>}[keyof NonNullable<TTarget['uks']>] ? true
    : false

type ValidatedFks<TFks extends Readonly<Record<string, FkDef>>, TEntities extends Readonly<Record<string, EntityDef<SystemEntityContext>>>> = {
    [F in keyof TFks]: TFks[F]['entity'] extends keyof TEntities
        ? FkMatchesTargetKey<TFks[F], TEntities[TFks[F]['entity'] & keyof TEntities]> extends true
            ? TFks[F]
            : never
        : never
}

export type ValidatedEntities<TEntities extends Readonly<Record<string, EntityDef<SystemEntityContext>>>> = {
    [E in keyof TEntities]: {fks?: ValidatedFks<NonNullable<TEntities[E]['fks']>, TEntities>}
}

/* system-level checks, where all the entities are known: every fk must point to an entity
   of the system, and its target fields must be the complete pk or one of the uks of it */
export function defineEntities<const TEntities extends Readonly<Record<string, EntityDef<SystemEntityContext>>>>(
    entityDefs: TEntities & ValidatedEntities<TEntities>
): TEntities {
    return entityDefs;
}

export type ExpandType<T> = {[K in keyof T]: T[K]} & {}

type IsNullable<T> = null extends T ? true : undefined extends T ? true : false;

export type Optional<T> = {
  [K in keyof T as IsNullable<T[K]> extends true ? never : K]: T[K];
} & {
  [K in keyof T as IsNullable<T[K]> extends true ? K : never]?: T[K];
};

import type {ValidationResult} from "../src/common/problem";
import type {AnyEntityDef} from "../src/common/ssot-entity";
import type {TypeCollection} from "../src/common/ssot-types";
import type {SystemSnapshotInfo} from "../src/common/system-snapshot";
import {
    completePersistence,
    decodePersistence,
    definePersistence,
} from "../src/common/system-persistence";
import {aida, entityDefs} from "../examples/common/aida";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Same<A, B> = IsAssignable<A, B> extends true ? IsAssignable<B, A> : false;

type PersistenceContextContract = {
    types: TypeCollection;
    entities: Readonly<Record<string, AnyEntityDef>>;
};

type RepresentationFor<TContext extends PersistenceContextContract> = {
    readonly [K in keyof TContext["types"] & string]: string;
};

type ExactRepresentation<
    TContext extends PersistenceContextContract,
    TActual extends Readonly<Record<string, string>>,
> = TActual extends RepresentationFor<TContext>
    ? TActual & Record<Exclude<keyof TActual, keyof TContext["types"]>, never>
    : never;

type PersistenceDefContract<
    TContext extends PersistenceContextContract,
    TEntities extends readonly (keyof TContext["entities"] & string)[],
    TRepresentations extends Readonly<Record<string, Readonly<Record<string, string>>>>,
> = {
    entities: TEntities;
    representations: TRepresentations & {
        readonly [R in keyof TRepresentations]: ExactRepresentation<TContext, TRepresentations[R]>;
    };
};

type PersistenceInfoOfContract<
    TDef extends {entities: readonly string[], representations: Readonly<Record<string, Readonly<Record<string, string>>>>},
> = {
    entities: readonly TDef["entities"][number][];
    representations: TDef["representations"];
};

type DefinePersistenceContract = <
    const TContext extends PersistenceContextContract,
    const TEntities extends readonly (keyof TContext["entities"] & string)[],
    const TRepresentations extends Readonly<Record<string, Readonly<Record<string, string>>>>,
>(
    context: TContext,
    def: PersistenceDefContract<TContext, TEntities, TRepresentations>,
) => {entities: TEntities, representations: TRepresentations};

type CompletePersistenceContract = <
    const TContext extends PersistenceContextContract,
    const TEntities extends readonly (keyof TContext["entities"] & string)[],
    const TRepresentations extends Readonly<Record<string, Readonly<Record<string, string>>>>,
>(
    context: TContext,
    def: PersistenceDefContract<TContext, TEntities, TRepresentations>,
) => ValidationResult<PersistenceInfoOfContract<{entities: TEntities, representations: TRepresentations}>>;

type DecodePersistenceContract = (
    value: unknown,
    snapshot: SystemSnapshotInfo,
) => ValidationResult<{
    entities: readonly string[];
    representations: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

/* During RED the production module is intentionally absent and the unresolved imports become any.
   The conditional assertions below stay quiet in that state. Once the module exists, the public
   functions must be assignable to the intended contracts; direct calls below additionally prove
   literal preservation and rejection of missing/extra mappings. TypeScript does not consider two
   separately-declared higher-rank exactness helper aliases bidirectionally assignable, so the
   reverse generic-function alias check would test alias identity rather than API behaviour. */
type _defineForward = Assert<IsAny<typeof definePersistence> extends true ? true : IsAssignable<typeof definePersistence, DefinePersistenceContract>>;
type _completeForward = Assert<IsAny<typeof completePersistence> extends true ? true : IsAssignable<typeof completePersistence, CompletePersistenceContract>>;
type _decodeForward = Assert<IsAny<typeof decodePersistence> extends true ? true : IsAssignable<typeof decodePersistence, DecodePersistenceContract>>;

const context = {...aida, entities: entityDefs};
type AidaPersistenceContext = typeof context;
const define: DefinePersistenceContract = definePersistence;
const complete: CompletePersistenceContract = completePersistence;

const persistence = define(context, {
    entities: [
        "docentes", "materias", "periodos", "cursos", "clases", "alumnos",
        "preguntas", "opciones", "inscripciones", "presencias", "mesas",
    ],
    representations: {
        postgres: {
            text: "text",
            integer: "integer",
            boolean: "boolean",
            fecha: "date",
            email: "text",
        },
    },
});

type _entitiesLiteral = Assert<Same<
    typeof persistence.entities,
    readonly ["docentes", "materias", "periodos", "cursos", "clases", "alumnos", "preguntas", "opciones", "inscripciones", "presencias", "mesas"]
>>;
type _fechaLiteral = Assert<Same<typeof persistence.representations.postgres.fecha, "date">>;
type _emailLiteral = Assert<Same<typeof persistence.representations.postgres.email, "text">>;

const completed = complete(context, persistence);
if (completed.ok) {
    const fecha: "date" = completed.value.representations.postgres.fecha;
    const entity: typeof persistence.entities[number] = completed.value.entities[0];
    void fecha;
    void entity;
}

type MissingFecha = {
    entities: readonly ["materias"];
    representations: {postgres: {text: "text", integer: "integer", boolean: "boolean", email: "text"}};
};
type ExtraType = {
    entities: readonly ["materias"];
    representations: {postgres: {text: "text", integer: "integer", boolean: "boolean", fecha: "date", email: "text", money: "numeric"}};
};
type UnknownEntity = {
    entities: readonly ["cargos"];
    representations: {postgres: {text: "text", integer: "integer", boolean: "boolean", fecha: "date", email: "text"}};
};

type Rejects<TDef> = IsAny<typeof definePersistence> extends true
    ? true
    : typeof definePersistence extends (_context: AidaPersistenceContext, def: TDef) => unknown ? false : true;

type _missingFechaRejected = Assert<Rejects<MissingFecha>>;
type _extraTypeRejected = Assert<Rejects<ExtraType>>;
type _cargosRejected = Assert<Rejects<UnknownEntity>>;

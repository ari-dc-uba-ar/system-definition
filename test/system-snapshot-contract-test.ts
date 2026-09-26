import type {EntityDef, EntityInfoOf, SystemEntityContext} from "../src/common/ssot-entity";
import type {RecordDef, RecordInfoOf} from "../src/common/ssot-record";
import type {ValidationResult} from "../src/common/problem";
import {captureSystemSnapshot} from "../src/common/system-snapshot";
import {aida, alumnoSearchParams, clases, entityDefs} from "../examples/common/aida";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type SnapshotInput<TContext extends SystemEntityContext> = {
    systemId: string;
    entities: Record<string, EntityDef<TContext>>;
    records?: Record<string, RecordDef<TContext>>;
};

type SnapshotRecordsOf<TContext extends SystemEntityContext, TInput> =
    TInput extends {records: infer TRecords extends Record<string, RecordDef<TContext>>}
        ? {[K in keyof TRecords]: RecordInfoOf<TContext, TRecords[K]>}
        : {};

type ExpectedSnapshotOf<
    TContext extends SystemEntityContext,
    TInput extends SnapshotInput<TContext>,
> = {
    formatVersion: 1;
    systemId: TInput["systemId"];
    typeNames: readonly (keyof TContext["types"] & string)[];
    entities: {[K in keyof TInput["entities"]]: EntityInfoOf<TContext, TInput["entities"][K]>};
    records: SnapshotRecordsOf<TContext, TInput>;
};

type CaptureSystemSnapshotContract = <
    const TContext extends SystemEntityContext,
    const TInput extends SnapshotInput<TContext>,
>(context: TContext, input: TInput) => ValidationResult<ExpectedSnapshotOf<TContext, TInput>>;

/* Use the expected public signature for the contract assertions. While the production module is
   intentionally absent at RED, TypeScript treats the unresolved import as any; assigning it here
   keeps the downstream assertions meaningful instead of producing unused @ts-expect-error noise. */
const capture: CaptureSystemSnapshotContract = captureSystemSnapshot;

type ExpectedClasesInfo = EntityInfoOf<typeof aida, typeof clases>;
type ExpectedSearchInfo = RecordInfoOf<typeof aida, typeof alumnoSearchParams>;

const captured = capture(aida, {
    systemId: "aida",
    entities: entityDefs,
    records: {alumnoSearchParams},
});

if (captured.ok) {
    const snapshot = captured.value;

    const formatVersion: 1 = snapshot.formatVersion;
    const systemId: "aida" = snapshot.systemId;

    type _clasesForward = Assert<IsAssignable<typeof snapshot.entities.clases, ExpectedClasesInfo>>;
    type _clasesBackward = Assert<IsAssignable<ExpectedClasesInfo, typeof snapshot.entities.clases>>;
    type _recordForward = Assert<IsAssignable<typeof snapshot.records.alumnoSearchParams, ExpectedSearchInfo>>;
    type _recordBackward = Assert<IsAssignable<ExpectedSearchInfo, typeof snapshot.records.alumnoSearchParams>>;

    const clasesPk: readonly ["periodo", "materia", "orden"] = snapshot.entities.clases.pk;
    const clasesPkBack: typeof snapshot.entities.clases.pk = clasesPk;
    const fechaType: "fecha" = snapshot.entities.clases.fields.fecha.type;
    const searchDateType: "fecha" = snapshot.records.alumnoSearchParams.desde.type;

    // @ts-expect-error entity keys stay exact; runtime decoding is the wide boundary instead.
    snapshot.entities.inexistente;
    // @ts-expect-error record keys stay exact when the capture input names them.
    snapshot.records.inexistente;

    void formatVersion;
    void systemId;
    void clasesPkBack;
    void fechaType;
    void searchDateType;
}

const withoutRecords = capture(aida, {
    systemId: "aida-no-records",
    entities: entityDefs,
});

if (withoutRecords.ok) {
    type _recordsForward = Assert<IsAssignable<typeof withoutRecords.value.records, {}>>;
    type _recordsBackward = Assert<IsAssignable<{}, typeof withoutRecords.value.records>>;
    // @ts-expect-error omitted records complete to the exact empty object type.
    withoutRecords.value.records.alumnoSearchParams;
}

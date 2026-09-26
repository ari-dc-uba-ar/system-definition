import type {ValidationResult} from "../src/common/problem";
import {
    completeMigration,
    decodeMigration,
    defineMigration,
    defineMigrations,
} from "../src/common/migration";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Same<A, B> = IsAssignable<A, B> extends true ? IsAssignable<B, A> : false;

type FileInfoContract = {
    path: string;
    contentHash: string;
    byteLength: number;
};

type ReleaseRefInfoContract = {
    systemId: string;
    releaseId: string;
    releaseHash: string;
};

type ResourceInfoContract = {
    kind: "sql" | "check";
    file: FileInfoContract;
};

type ResourceRefInfoContract = {
    name: string;
    kind: "sql" | "check";
    contentHash: string;
};

type MigrationContextContract = {
    releases: Readonly<Record<string, ReleaseRefInfoContract>>;
    resources: Readonly<Record<string, ResourceInfoContract>>;
};

type ResourceNamesFor<
    TContext extends MigrationContextContract,
    TKind extends ResourceInfoContract["kind"],
> = {
    [N in keyof TContext["resources"]]:
        TContext["resources"][N]["kind"] extends TKind ? N : never
}[keyof TContext["resources"]] & string;

type MigrationDefContract<TContext extends MigrationContextContract> = {
    id: string;
    from: keyof TContext["releases"] & string;
    to: keyof TContext["releases"] & string;
    description?: string;
    before?: readonly ResourceNamesFor<TContext, "check">[];
    steps: readonly {
        id: string;
        run: ResourceNamesFor<TContext, "sql">;
    }[];
    after?: readonly ResourceNamesFor<TContext, "check">[];
};

type ExactMigrationDef<
    TContext extends MigrationContextContract,
    TDef extends MigrationDefContract<TContext>,
> = TDef
    & Record<Exclude<keyof TDef, keyof MigrationDefContract<TContext>>, never>
    & {
        steps: TDef["steps"] & {
            readonly [I in keyof TDef["steps"]]: TDef["steps"][I] extends {id: string, run: string}
                ? TDef["steps"][I] & Record<Exclude<keyof TDef["steps"][I], "id" | "run">, never>
                : TDef["steps"][I];
        };
    };

type ResourceRefFor<
    TContext extends MigrationContextContract,
    TName extends keyof TContext["resources"] & string,
> = {
    name: TName;
    kind: TContext["resources"][TName]["kind"];
    contentHash: TContext["resources"][TName]["file"]["contentHash"];
};

type ResourceRefsFor<
    TContext extends MigrationContextContract,
    TNames extends readonly (keyof TContext["resources"] & string)[],
> = {
    readonly [I in keyof TNames]: TNames[I] extends keyof TContext["resources"] & string
        ? ResourceRefFor<TContext, TNames[I]>
        : never;
};

type StepsInfoFor<
    TContext extends MigrationContextContract,
    TSteps extends readonly {id: string, run: keyof TContext["resources"] & string}[],
> = {
    readonly [I in keyof TSteps]: TSteps[I] extends {id: infer TId extends string, run: infer TRun extends keyof TContext["resources"] & string}
        ? {id: TId, run: ResourceRefFor<TContext, TRun>}
        : never;
};

type MigrationInfoOfContract<
    TContext extends MigrationContextContract,
    TDef extends MigrationDefContract<TContext>,
> = {
    id: TDef["id"];
    from: TContext["releases"][TDef["from"]];
    to: TContext["releases"][TDef["to"]];
    description: TDef extends {description: infer TDescription extends string} ? TDescription : "";
    before: TDef extends {before: infer TBefore extends readonly ResourceNamesFor<TContext, "check">[]}
        ? ResourceRefsFor<TContext, TBefore>
        : readonly [];
    steps: StepsInfoFor<TContext, TDef["steps"]>;
    after: TDef extends {after: infer TAfter extends readonly ResourceNamesFor<TContext, "check">[]}
        ? ResourceRefsFor<TContext, TAfter>
        : readonly [];
};

type MigrationInfoContract = {
    id: string;
    from: ReleaseRefInfoContract;
    to: ReleaseRefInfoContract;
    description: string;
    before: readonly ResourceRefInfoContract[];
    steps: readonly {id: string, run: ResourceRefInfoContract}[];
    after: readonly ResourceRefInfoContract[];
};

type DefineMigrationContract = <
    const TContext extends MigrationContextContract,
    const TDef extends MigrationDefContract<TContext>,
>(context: TContext, def: TDef & ExactMigrationDef<TContext, TDef>) => TDef;

type CompleteMigrationContract = <
    const TContext extends MigrationContextContract,
    const TDef extends MigrationDefContract<TContext>,
>(context: TContext, def: TDef & ExactMigrationDef<TContext, TDef>) => ValidationResult<MigrationInfoOfContract<TContext, TDef>>;

type DefineMigrationsContract = <
    const TContext extends MigrationContextContract,
    const TDefs extends Readonly<Record<string, MigrationDefContract<TContext>>>,
>(
    context: TContext,
    defs: TDefs & {
        readonly [K in keyof TDefs]: TDefs[K]
            & ExactMigrationDef<TContext, TDefs[K]>
            & {id: K & string};
    },
) => TDefs;

type DecodeMigrationContract = (
    value: unknown,
    context: MigrationContextContract,
) => ValidationResult<MigrationInfoContract>;

/* The decoder has a simple non-generic boundary and can be checked by assignability directly.
   For define/complete/defineMany, the direct calls and rejection assertions below are the contract:
   re-applying a separately-declared higher-rank ExactMigrationDef helper while comparing generic
   function aliases recursively exact-checks the already-exact argument instead of testing the API. */
type _decodeForward = Assert<IsAny<typeof decodeMigration> extends true ? true : IsAssignable<typeof decodeMigration, DecodeMigrationContract>>;

const context = {
    releases: {
        aida_001: {systemId: "aida", releaseId: "aida_001", releaseHash: "release-001"},
        aida_002: {systemId: "aida", releaseId: "aida_002", releaseHash: "release-002"},
    },
    resources: {
        email_source_complete_v1: {
            kind: "check",
            file: {path: "checks/email-source.sql", contentHash: "check-before-hash", byteLength: 10},
        },
        backfill_alumno_email_v1: {
            kind: "sql",
            file: {path: "sql/backfill-email.sql", contentHash: "sql-fill-hash", byteLength: 20},
        },
        require_alumno_email_v1: {
            kind: "sql",
            file: {path: "sql/require-email.sql", contentHash: "sql-require-hash", byteLength: 30},
        },
        alumno_email_required_v1: {
            kind: "check",
            file: {path: "checks/email-required.sql", contentHash: "check-after-hash", byteLength: 40},
        },
    },
} as const;

type TestContext = typeof context;
const migration = defineMigration(context, {
    id: "alumnos_email_required",
    from: "aida_001",
    to: "aida_002",
    before: ["email_source_complete_v1"],
    steps: [
        {id: "fill_email", run: "backfill_alumno_email_v1"},
        {id: "require_email", run: "require_alumno_email_v1"},
    ],
    after: ["alumno_email_required_v1"],
});

type _idLiteral = Assert<Same<typeof migration.id, "alumnos_email_required">>;
type _fromLiteral = Assert<Same<typeof migration.from, "aida_001">>;
type _beforeLiteral = Assert<Same<typeof migration.before, readonly ["email_source_complete_v1"]>>;
type _stepIdLiteral = Assert<Same<typeof migration.steps[0]["id"], "fill_email">>;
type _stepResourceLiteral = Assert<Same<typeof migration.steps[1]["run"], "require_alumno_email_v1">>;

const minimal = defineMigration(context, {
    id: "metadata_only",
    from: "aida_001",
    to: "aida_002",
    steps: [],
});
const completedMinimal = completeMigration(context, minimal);
if (completedMinimal.ok) {
    const description: "" = completedMinimal.value.description;
    const before: readonly [] = completedMinimal.value.before;
    const after: readonly [] = completedMinimal.value.after;
    const from: typeof context.releases.aida_001 = completedMinimal.value.from;
    void description;
    void before;
    void after;
    void from;
}

const completed = completeMigration(context, migration);
if (completed.ok) {
    const beforeKind: "check" = completed.value.before[0].kind;
    const beforeName: "email_source_complete_v1" = completed.value.before[0].name;
    const runKind: "sql" = completed.value.steps[0].run.kind;
    const runHash: "sql-fill-hash" = completed.value.steps[0].run.contentHash;
    const stepId: "fill_email" = completed.value.steps[0].id;
    void beforeKind;
    void beforeName;
    void runKind;
    void runHash;
    void stepId;
}

const migrations = defineMigrations(context, {
    alumnos_email_required: migration,
    metadata_only: minimal,
});
type _mapKeyPreserved = Assert<Same<keyof typeof migrations, "alumnos_email_required" | "metadata_only">>;

type BadBeforeTypo = {
    id: "bad";
    from: "aida_001";
    to: "aida_002";
    befor: readonly ["email_source_complete_v1"];
    steps: readonly [];
};
type BadStepsTypo = {
    id: "bad";
    from: "aida_001";
    to: "aida_002";
    stepps: readonly [];
    steps: readonly [];
};
type BadBeforeKind = {
    id: "bad";
    from: "aida_001";
    to: "aida_002";
    before: readonly ["backfill_alumno_email_v1"];
    steps: readonly [];
};
type BadRunKind = {
    id: "bad";
    from: "aida_001";
    to: "aida_002";
    steps: readonly [{id: "one", run: "email_source_complete_v1"}];
};
type BadStepExtra = {
    id: "bad";
    from: "aida_001";
    to: "aida_002";
    steps: readonly [{id: "one", run: "backfill_alumno_email_v1", transaction: true}];
};
type BadMapKey = {
    wrong_key: typeof migration;
};

type RejectsDef<TDef> = IsAny<typeof defineMigration> extends true
    ? true
    : typeof defineMigration extends (_context: TestContext, def: TDef) => unknown ? false : true;
type RejectsMap<TDefs> = IsAny<typeof defineMigrations> extends true
    ? true
    : typeof defineMigrations extends (_context: TestContext, defs: TDefs) => unknown ? false : true;

type _beforRejected = Assert<RejectsDef<BadBeforeTypo>>;
type _steppsRejected = Assert<RejectsDef<BadStepsTypo>>;
type _beforeKindRejected = Assert<RejectsDef<BadBeforeKind>>;
type _runKindRejected = Assert<RejectsDef<BadRunKind>>;
type _stepExtraRejected = Assert<RejectsDef<BadStepExtra>>;
type _mapKeyRejected = Assert<RejectsMap<BadMapKey>>;

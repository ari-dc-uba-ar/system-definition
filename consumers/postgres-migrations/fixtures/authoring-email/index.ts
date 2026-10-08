/**
 * Executable version of the Section 11 migration-authoring example.
 *
 * This fixture deliberately starts from the same public SSOT APIs an application uses:
 * it defines release A/B, captures snapshots, projects PostgreSQL schemas, infers the
 * structural diff, builds the source query, completes a typed row transformation and data
 * migration, records destructive decisions, and finally runs the authoring compiler through
 * an in-memory runtime.  The values exported below are therefore real contracts, not copied
 * JSON shapes maintained beside the implementation.
 */
import {createHash} from "node:crypto";
import {
    canonicalJson,
    captureSystemSnapshot,
    commonTypeBehaviours,
    commonTypeDefs,
    completeCoreField,
    defineEntities,
    defineEntity,
    defineRecord,
    defineTypes,
    problem,
    sameReleaseRef,
    toJsonValue,
    withRecords,
    type PersistenceInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type StructuralFailure,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import {
    decodeDestructiveDecisionInfo,
    type AuthoringBaseInfo,
    type AuthoringRuntime,
    type DestructiveDecisionInfo,
    type MigrationDraftInfo,
    type StructureChangeInfo,
} from "../../src/authoring-contract";
import {inferStructureChanges} from "../../src/infer";
import {
    completeDataMigration,
    completeTransformation,
    type AuthoringContext,
    type DataMigrationInfo,
    type QueryRefInfo,
    type TransformationInfo,
} from "../../src/migration-authoring";
import {projectSchema, type PgSchemaInfo, type StorageContext} from "../../src/pg-schema";
import {buildSourceSelection} from "../../src/source-selection";

function expectOk<T>(result: ValidationResult<T>, label: string): T {
    if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.problems)}`);
    return result.value;
}

function sha256Text(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalHash(value: unknown): string {
    const json = expectOk(toJsonValue(value), "example value is not strict JSON");
    return sha256Text(canonicalJson(json));
}

const fixtureTypeDefs = commonTypeDefs;
type FixtureFieldDef = {type: keyof typeof fixtureTypeDefs; nullable?: boolean};

export const fixtureTypes = defineTypes({
    types: fixtureTypeDefs,
    behaviours: commonTypeBehaviours,
    completeField: (field: FixtureFieldDef, name: string) => completeCoreField(field, name),
});

// Release A has the historical source fields that the migration must explicitly account for.
const recordA = defineRecord(fixtureTypes, {
    alumno: {type: "integer", nullable: false},
    nombres: {type: "text", nullable: false},
    email_anterior: {type: "text", nullable: true},
    nota_legacy: {type: "text", nullable: true},
});
const contextA = withRecords(fixtureTypes, {alumno: recordA});
const alumnosA = defineEntity(contextA, {name: "alumnos", record: "alumno", pk: ["alumno"]});
export const authoringEmailEntitiesA = defineEntities({alumnos: alumnosA});

// Release B keeps the identity/name fields, introduces email, and removes both historical fields.
const recordB = defineRecord(fixtureTypes, {
    alumno: {type: "integer", nullable: false},
    nombres: {type: "text", nullable: false},
    email: {type: "text", nullable: true},
});
const contextB = withRecords(fixtureTypes, {alumno: recordB});
const alumnosB = defineEntity(contextB, {name: "alumnos", record: "alumno", pk: ["alumno"]});
export const authoringEmailEntitiesB = defineEntities({alumnos: alumnosB});

function snapshot(
    context: typeof contextA | typeof contextB,
    entities: typeof authoringEmailEntitiesA | typeof authoringEmailEntitiesB,
): SystemSnapshotInfo {
    return expectOk(
        captureSystemSnapshot(context as never, {systemId: "authoring-email", entities} as never),
        "authoring-email snapshot",
    );
}

export const authoringEmailSnapshotA = snapshot(contextA, authoringEmailEntitiesA);
export const authoringEmailSnapshotB = snapshot(contextB, authoringEmailEntitiesB);

export const authoringEmailPersistence: PersistenceInfo = {
    entities: ["alumnos"],
    representations: {
        postgres: {text: "text", integer: "integer", boolean: "boolean"},
    },
};

export const authoringEmailStorage: StorageContext = {
    representation: "postgres",
    physicalTypes: {
        text: {schema: "pg_catalog", name: "text", modifiers: []},
        integer: {schema: "pg_catalog", name: "int4", modifiers: []},
        boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
    },
    machineCodecs: {
        text: {readExpression: "migration_value", transportType: "text"},
        integer: {readExpression: "migration_value::text", transportType: "text"},
        boolean: {readExpression: "CASE WHEN migration_value THEN 'true' ELSE 'false' END", transportType: "text"},
    },
    schema: "app",
    environment: {
        engine: "postgresql",
        version: "18.6",
        serverVersionNum: 180006,
        encoding: "UTF8",
        collations: {},
        externalDependencies: {},
    },
    resources: {},
    createResources: [],
    managedData: [],
    invariantChecks: [],
};

export const authoringEmailSchemaA = expectOk(
    projectSchema(authoringEmailSnapshotA, authoringEmailPersistence, authoringEmailStorage),
    "project release A",
);
export const authoringEmailSchemaB = expectOk(
    projectSchema(authoringEmailSnapshotB, authoringEmailPersistence, authoringEmailStorage),
    "project release B",
);

const snapshotHashA = canonicalHash(authoringEmailSnapshotA);
const snapshotHashB = canonicalHash(authoringEmailSnapshotB);
const persistenceHash = canonicalHash(authoringEmailPersistence);

export const authoringEmailReleaseA: ReleaseRefInfo = {
    systemId: "authoring-email",
    releaseId: "A",
    releaseHash: canonicalHash({snapshotHash: snapshotHashA, persistenceHash}),
};
export const authoringEmailReleaseB: ReleaseRefInfo = {
    systemId: "authoring-email",
    releaseId: "B",
    releaseHash: canonicalHash({snapshotHash: snapshotHashB, persistenceHash}),
};

export const authoringEmailBase: AuthoringBaseInfo = {
    from: authoringEmailReleaseA,
    to: authoringEmailReleaseB,
    fromSnapshotHash: snapshotHashA,
    toSnapshotHash: snapshotHashB,
    fromPersistenceHash: persistenceHash,
    toPersistenceHash: persistenceHash,
};

export const authoringEmailChanges: readonly StructureChangeInfo[] = expectOk(
    inferStructureChanges(authoringEmailBase, authoringEmailSchemaA, authoringEmailSchemaB, []),
    "infer authoring-email changes",
);

const emptyAuthoringContext: AuthoringContext = {
    from: authoringEmailSnapshotA,
    to: authoringEmailSnapshotB,
    transformations: {},
};

// The supported source-selection builder owns quoting, field lookup, nullability and query hashing.
export const authoringEmailSource = expectOk(buildSourceSelection(emptyAuthoringContext, {
    queryName: "authoring-email-source.sql",
    schema: "app",
    base: {entity: "alumnos", alias: "a"},
    joins: [],
    ports: {
        alumno: {alias: "a", field: "alumno"},
        email_anterior: {alias: "a", field: "email_anterior"},
    },
    identity: ["alumno"],
    coverageChecks: [],
}), "build authoring-email source selection");

export const authoringEmailTransformationSql = [
    "SELECT i.__source_id, i.alumno, i.email_anterior AS email",
    "FROM migration_input AS i;",
    "",
].join("\n");

export const authoringEmailTransformationQuery: QueryRefInfo = {
    name: "move-email.sql",
    kind: "query",
    contentHash: sha256Text(authoringEmailTransformationSql),
};

const transformationDef = {
    name: "move-email",
    version: "1",
    inputs: authoringEmailSource.selection.ports,
    parameters: {},
    outputs: {
        alumno: {
            domain: {side: "to", type: "integer", nullable: false},
            field: {side: "to", entity: "alumnos", field: "alumno"},
        },
        email: {
            domain: {side: "to", type: "text", nullable: true},
            field: {side: "to", entity: "alumnos", field: "email"},
        },
    },
    mode: "row",
    query: authoringEmailTransformationQuery,
} as const;

export const authoringEmailTransformation: TransformationInfo = expectOk(
    completeTransformation(emptyAuthoringContext, transformationDef),
    "complete move-email transformation",
);

export const authoringEmailContext = {
    from: authoringEmailSnapshotA,
    to: authoringEmailSnapshotB,
    transformations: {"move-email": authoringEmailTransformation},
} as const satisfies AuthoringContext;

export const authoringEmailConservationSql = [
    "SELECT NOT EXISTS (",
    "  SELECT 1 FROM app.alumnos",
    "  WHERE email_anterior IS DISTINCT FROM email",
    ") AS ok;",
    "",
].join("\n");

export const authoringEmailConservationCheck: ResourceRefInfo = {
    name: "authoring-email-conserved.sql",
    kind: "check",
    contentHash: sha256Text(authoringEmailConservationSql),
};

const dataMigrationDef = {
    id: "move-email",
    description: "copy alumnos.email_anterior into alumnos.email before removing the historical source",
    source: authoringEmailSource.selection,
    transformation: "move-email",
    arguments: {},
    writes: [{
        kind: "update",
        entity: "alumnos",
        values: [{output: "email", target: {side: "to", entity: "alumnos", field: "email"}}],
        match: [{output: "alumno", targetField: "alumno"}],
        whenMissing: "error",
    }],
    conservationChecks: [authoringEmailConservationCheck],
} as const;

export const authoringEmailDataMigration: DataMigrationInfo = expectOk(
    completeDataMigration(authoringEmailContext, dataMigrationDef),
    "complete move-email data migration",
);

function changeForHistoricalField(field: "email_anterior" | "nota_legacy"): StructureChangeInfo {
    const change = authoringEmailChanges.find(candidate => candidate.impact === "destructive"
        && candidate.affectedFields.some(ref => ref.side === "from"
            && ref.entity === "alumnos"
            && ref.field === field));
    if (change === undefined) throw new Error(`missing destructive change for alumnos.${field}`);
    return change;
}

const structuralInvalid: StructuralFailure = (path, reason) => ({
    ok: false,
    problems: [problem(path, "migration.authoringInvalid", "blocking", {reason})],
});

const emailChange = changeForHistoricalField("email_anterior");
const legacyNoteChange = changeForHistoricalField("nota_legacy");

export const authoringEmailDecisions: readonly DestructiveDecisionInfo[] = [
    expectOk(decodeDestructiveDecisionInfo({
        changeId: emailChange.id,
        source: {side: "from", entity: "alumnos", field: "email_anterior"},
        partitionCheck: null,
        resolution: {kind: "migrate", dataMigrationId: "move-email", outputs: ["email"]},
    }, "$[0]", structuralInvalid), "decode email migration decision"),
    expectOk(decodeDestructiveDecisionInfo({
        changeId: legacyNoteChange.id,
        source: {side: "from", entity: "alumnos", field: "nota_legacy"},
        partitionCheck: null,
        resolution: {kind: "discard", reason: "legacy note is intentionally retired by the example"},
    }, "$[1]", structuralInvalid), "decode legacy-note discard decision"),
];

const draftAuthority = {
    base: authoringEmailBase,
    renames: [],
    data: [authoringEmailDataMigration],
    decisions: authoringEmailDecisions,
    manual: [],
};

export const authoringEmailDraft: MigrationDraftInfo = {
    formatVersion: 1,
    id: "A-B",
    base: authoringEmailBase,
    revisionHash: canonicalHash(draftAuthority),
    renames: [],
    changes: authoringEmailChanges,
    data: [authoringEmailDataMigration],
    decisions: authoringEmailDecisions,
    manual: [],
    pending: [],
};

function result<T>(value: T): ValidationResult<T> {
    return {ok: true, value};
}

function unknownRelease(ref: ReleaseRefInfo): ValidationResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidReference", "blocking", {releaseId: ref.releaseId})],
    };
}

export const queryTextByName: Readonly<Record<string, string>> = {
    [authoringEmailSource.selection.query.name]: authoringEmailSource.sql,
    [authoringEmailTransformationQuery.name]: authoringEmailTransformationSql,
};

// A compact discovery export for readers who want the complete example from one import.
export const authoringEmailFixture = {
    from: authoringEmailSnapshotA,
    to: authoringEmailSnapshotB,
    source: authoringEmailSource,
    transformation: authoringEmailTransformation,
    dataMigration: authoringEmailDataMigration,
    decisions: authoringEmailDecisions,
    draft: authoringEmailDraft,
} as const;

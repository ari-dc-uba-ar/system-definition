import {
    captureSystemSnapshot,
    commonTypeBehaviours,
    commonTypeDefs,
    completeCoreField,
    defineEntities,
    defineEntity,
    defineRecord,
    defineTypes,
    withRecords,
    type MigrationPathInfo,
    type PersistenceInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import type {MigrationExecutionContext, ReleaseExecutionState} from "../../src/execute-migration";
import type {InstallationScope, JournalConfig} from "../../src/journal";
import type {InspectionScope} from "../../src/inspect-schema";
import {
    projectSchema,
    type PgSchemaInfo,
    type PgSession,
    type ResolvedSqlResource,
    type StorageContext,
} from "../../src/pg-schema";

const fixtureTypeDefs = {
    ...commonTypeDefs,
    email: commonTypeDefs.text,
};
type FixtureFieldDef = {type: keyof typeof fixtureTypeDefs; nullable?: boolean};

const fixtureTypes = defineTypes({
    types: fixtureTypeDefs,
    behaviours: {...commonTypeBehaviours, email: commonTypeBehaviours.text},
    completeField: (field: FixtureFieldDef, name: string) => completeCoreField(field, name),
});

const alumnoARecord = defineRecord(fixtureTypes, {
    alumno: {type: "text"},
    apellido: {type: "text", nullable: false},
    nombres: {type: "text", nullable: false},
    email: {type: "email"},
});
const contactoARecord = defineRecord(fixtureTypes, {
    alumno: {type: "text"},
    email: {type: "email", nullable: false},
});
const contextA = withRecords(fixtureTypes, {alumno: alumnoARecord, contacto_alumno: contactoARecord});
const alumnosA = defineEntity(contextA, {name: "alumnos", record: "alumno", pk: ["alumno"]});
const contactosA = defineEntity(contextA, {
    name: "contactos_alumnos",
    record: "contacto_alumno",
    pk: ["alumno"],
    fks: {alumnos: {entity: "alumnos", fields: {alumno: "alumno"}}},
});
export const aidaEmailEntitiesA = defineEntities({alumnos: alumnosA, contactos_alumnos: contactosA});

const alumnoBRecord = defineRecord(fixtureTypes, {
    alumno: {type: "text"},
    apellido: {type: "text", nullable: false},
    nombres: {type: "text", nullable: false},
    email: {type: "email", nullable: false},
});
const contactoBRecord = defineRecord(fixtureTypes, {
    alumno: {type: "text"},
    email: {type: "email", nullable: false},
});
const contextB = withRecords(fixtureTypes, {alumno: alumnoBRecord, contacto_alumno: contactoBRecord});
const alumnosB = defineEntity(contextB, {name: "alumnos", record: "alumno", pk: ["alumno"]});
const contactosB = defineEntity(contextB, {
    name: "contactos_alumnos",
    record: "contacto_alumno",
    pk: ["alumno"],
    fks: {alumnos: {entity: "alumnos", fields: {alumno: "alumno"}}},
});
export const aidaEmailEntitiesB = defineEntities({alumnos: alumnosB, contactos_alumnos: contactosB});

function snapshotA(): SystemSnapshotInfo {
    const captured = captureSystemSnapshot(contextA, {systemId: "aida-email", entities: aidaEmailEntitiesA});
    if (!captured.ok) throw new Error("historical A snapshot fixture is invalid");
    return captured.value;
}
function snapshotB(): SystemSnapshotInfo {
    const captured = captureSystemSnapshot(contextB, {systemId: "aida-email", entities: aidaEmailEntitiesB});
    if (!captured.ok) throw new Error("historical B snapshot fixture is invalid");
    return captured.value;
}

export const aidaEmailSnapshotA = snapshotA();
export const aidaEmailSnapshotB = snapshotB();

export const aidaEmailPersistence: PersistenceInfo = {
    entities: ["alumnos", "contactos_alumnos"],
    representations: {postgres: {text: "text", integer: "integer", boolean: "boolean", email: "text"}},
};

export const aidaEmailStorage: StorageContext = {
    representation: "postgres",
    physicalTypes: {
        text: {schema: "pg_catalog", name: "text", modifiers: []},
        integer: {schema: "pg_catalog", name: "int4", modifiers: []},
        boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
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

export const aidaEmailInspection: InspectionScope = {schemas: ["app"], excluded: []};
export const aidaEmailJournal: JournalConfig = {schema: "sd_journal"};
export const aidaEmailScope: InstallationScope = {systemId: "aida-email", schemas: ["app"]};

export const A: ReleaseRefInfo = {systemId: "aida-email", releaseId: "A", releaseHash: "a".repeat(64)};
export const B: ReleaseRefInfo = {systemId: "aida-email", releaseId: "B", releaseHash: "b".repeat(64)};

function ref(name: string, kind: ResourceRefInfo["kind"], hashChar: string): ResourceRefInfo {
    return {name, kind, contentHash: hashChar.repeat(64)};
}
export const emailSourceComplete = ref("email_source_complete_v1", "check", "c");
export const backfillEmail = ref("backfill_alumno_email_v1", "sql", "d");
export const requireEmail = ref("require_alumno_email_v1", "sql", "e");
export const emailRequired = ref("alumno_email_required_v1", "check", "f");

export const aidaEmailResources: Readonly<Record<string, ResolvedSqlResource>> = {
    email_source_complete_v1: {
        ref: emailSourceComplete,
        text: `SELECT NOT EXISTS (
    SELECT 1 FROM app.alumnos AS a
    LEFT JOIN app.contactos_alumnos AS c ON c.alumno = a.alumno
    WHERE a.email IS NULL AND c.email IS NULL
) AS ok`,
    },
    backfill_alumno_email_v1: {
        ref: backfillEmail,
        text: `UPDATE app.alumnos AS a SET email = c.email
FROM app.contactos_alumnos AS c
WHERE a.alumno = c.alumno AND a.email IS NULL`,
    },
    require_alumno_email_v1: {
        ref: requireEmail,
        text: `ALTER TABLE app.alumnos ALTER COLUMN email SET NOT NULL`,
    },
    alumno_email_required_v1: {
        ref: emailRequired,
        text: `SELECT NOT EXISTS (SELECT 1 FROM app.alumnos WHERE email IS NULL) AS ok`,
    },
};

function published(includeAlter: boolean): PublishedMigrationInfo {
    return {
        migration: {
            id: includeAlter ? "A-B" : "A-B-without-not-null",
            from: A,
            to: B,
            description: "historical email backfill fixture",
            before: [emailSourceComplete],
            steps: includeAlter
                ? [{id: "backfill", run: backfillEmail}, {id: "not-null", run: requireEmail}]
                : [{id: "backfill", run: backfillEmail}],
            after: [emailRequired],
        },
        migrationHash: (includeAlter ? "1" : "2").repeat(64),
    };
}

export const aidaEmailMigration = published(true);
export const aidaEmailMigrationWithoutAlter = published(false);
export const aidaEmailPath: MigrationPathInfo = {from: A, to: B, migrations: [aidaEmailMigration]};
export const aidaEmailPathWithoutAlter: MigrationPathInfo = {from: A, to: B, migrations: [aidaEmailMigrationWithoutAlter]};

export function projectedA(): PgSchemaInfo {
    const projected = projectSchema(aidaEmailSnapshotA, aidaEmailPersistence, aidaEmailStorage);
    if (!projected.ok) throw new Error("historical A projection fixture is invalid");
    return projected.value;
}
export function projectedB(): PgSchemaInfo {
    const projected = projectSchema(aidaEmailSnapshotB, aidaEmailPersistence, aidaEmailStorage);
    if (!projected.ok) throw new Error("historical B projection fixture is invalid");
    return projected.value;
}

export const fixtureRows = [
    {alumno: "a001", apellido: "Uno", nombres: "Ana", email: "ana@example.test", contacto: "alternativo@example.test"},
    {alumno: "a002", apellido: "Dos", nombres: "Luis", email: null, contacto: "luis@example.test"},
    {alumno: "a003", apellido: "Tres", nombres: "Eva", email: null, contacto: "eva@example.test"},
] as const;

export const expectedRowsAfterUpgrade = [
    {alumno: "a001", apellido: "Uno", nombres: "Ana", email: "ana@example.test"},
    {alumno: "a002", apellido: "Dos", nombres: "Luis", email: "luis@example.test"},
    {alumno: "a003", apellido: "Tres", nombres: "Eva", email: "eva@example.test"},
] as const;

export async function loadAidaEmailFixture(session: PgSession): Promise<ValidationResult<true>> {
    for (const row of fixtureRows) {
        await session.query(
            `INSERT INTO app.alumnos (alumno, apellido, nombres, email) VALUES ($1,$2,$3,$4)`,
            [row.alumno, row.apellido, row.nombres, row.email],
        );
        await session.query(
            `INSERT INTO app.contactos_alumnos (alumno, email) VALUES ($1,$2)`,
            [row.alumno, row.contacto],
        );
    }
    return {ok: true, value: true};
}

export async function verifyAidaEmailFixture(session: PgSession): Promise<ValidationResult<true>> {
    const queried = await session.query(
        `SELECT alumno, apellido, nombres, email FROM app.alumnos ORDER BY alumno`,
        [],
    );
    const actual = queried.rows.map(row => ({
        alumno: row.alumno,
        apellido: row.apellido,
        nombres: row.nombres,
        email: row.email,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expectedRowsAfterUpgrade)) {
        return {
            ok: false,
            problems: [{field: null, messageKey: "migration.checkFailed", severity: "blocking", details: {fixture: "aida-email"}}],
        };
    }
    return {ok: true, value: true};
}

export function executionContext(migration: PublishedMigrationInfo): MigrationExecutionContext {
    const source: ReleaseExecutionState = {
        expectedSchema: projectedA(), inspection: aidaEmailInspection, managedData: [], invariantChecks: [],
    };
    const target: ReleaseExecutionState = {
        expectedSchema: projectedB(), inspection: aidaEmailInspection, managedData: [], invariantChecks: [],
    };
    return {
        journal: aidaEmailJournal,
        scope: aidaEmailScope,
        resources: aidaEmailResources,
        from: source,
        to: target,
        options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
        now: () => "2026-09-28T18:00:00.000Z",
    };
}

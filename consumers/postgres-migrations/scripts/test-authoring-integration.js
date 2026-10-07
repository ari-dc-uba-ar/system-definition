const assert = require("node:assert/strict");
const {canonicalJson} = require("system-definition");
const {
    bootstrapJournal,
    installBaseline,
    buildMigrationPlan,
    checkDeploymentReady,
    computeMigrationHash,
    executeMigrationPath,
    resolveMigrationExecutionContext,
    sha256Hex,
} = require("../dist/src/index.js");
const {PsqlSession, parsePgArray} = require("./lib/psql-session.js");

const encoder = new TextEncoder();
const ZERO_HASH = "0".repeat(64);
const JOURNAL = {schema: "sd_journal"};
const SCOPE = {systemId: "authoring-email", schemas: ["app"]};

function hashText(value) {
    return sha256Hex(encoder.encode(value));
}

function release(releaseId) {
    return {
        systemId: "authoring-email",
        releaseId,
        releaseHash: hashText(`release:${releaseId}`),
    };
}

const ARRAY_COLUMNS = new Set(["schemas", "signature", "type_modifiers", "columns"]);
const JSON_COLUMNS = new Set(["binding", "checks", "problems", "pairs", "options"]);
const BOOLEAN_COLUMNS = new Set([
    "nullable", "deferrable", "initially_deferred", "validated", "enforced", "valid", "ready", "ok",
]);
const NUMBER_COLUMNS = new Set(["ordinal", "array_dimensions", "journal_format_version"]);

function typedValue(column, value) {
    if (ARRAY_COLUMNS.has(column)) return parsePgArray(value);
    if (JSON_COLUMNS.has(column)) return JSON.parse(value);
    if (BOOLEAN_COLUMNS.has(column) && (value === "t" || value === "f")) return value === "t";
    if (NUMBER_COLUMNS.has(column) && /^-?\d+$/u.test(value)) return Number(value);
    return value;
}

function field(name, type, nullable) {
    return {name, type, nullable};
}

function snapshot(fields) {
    return {
        formatVersion: 1,
        systemId: "authoring-email",
        typeNames: ["integer", "text"],
        entities: {
            alumnos: {
                name: "alumnos",
                record: "alumnos",
                fields,
                pk: ["alumno"],
                uks: {},
                fks: {},
                validators: [],
            },
        },
        records: {},
    };
}

const BASE_FIELDS = {
    alumno: field("alumno", "integer", false),
    nombres: field("nombres", "text", false),
};
const EMAIL_FROM = snapshot({
    ...BASE_FIELDS,
    email_anterior: field("email_anterior", "text", true),
    nota_legacy: field("nota_legacy", "text", true),
});
const EMAIL_TO = snapshot({...BASE_FIELDS, email: field("email", "text", true)});
const ADD_FROM = snapshot({...BASE_FIELDS});
const ADD_TO = snapshot({...BASE_FIELDS, email: field("email", "text", true)});

function schemaState() {
    const excludedNames = ["alumno", "nombres", "email", "email_anterior", "nota_legacy"];
    const excluded = [
        {object: {schema: "app", kind: "table", name: "alumnos", parentName: null, signature: []}, reason: "fixture-owned table"},
        ...excludedNames.map((name) => ({
            object: {schema: "app", kind: "column", name, parentName: "alumnos", signature: []},
            reason: "fixture-owned column",
        })),
        {object: {schema: "app", kind: "constraint", name: "alumnos_pkey", parentName: "alumnos", signature: []}, reason: "fixture-owned primary key"},
        {object: {schema: "app", kind: "index", name: "alumnos_pkey", parentName: "alumnos", signature: []}, reason: "constraint-owned index"},
    ];
    return {
        expectedSchema: {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []},
        inspection: {schemas: ["app"], excluded},
        managedData: [],
        invariantChecks: [],
    };
}

function resource(name, text, kind = "sql") {
    return {
        ref: {name, kind, contentHash: hashText(text)},
        text,
    };
}

function authoringArtifact(migration, fromSnapshot, toSnapshot, decisions) {
    const fromSnapshotHash = hashText(canonicalJson(fromSnapshot));
    const toSnapshotHash = hashText(canonicalJson(toSnapshot));
    const authoring = {
        formatVersion: 1,
        draftHash: hashText(`draft:${migration.id}`),
        base: {
            from: migration.from,
            to: migration.to,
            fromSnapshotHash,
            toSnapshotHash,
            fromPersistenceHash: hashText("persistence:from"),
            toPersistenceHash: hashText("persistence:to"),
        },
        migration,
        operations: [],
        decisions,
        checkpoints: [],
        queryResources: {},
        validationArtifacts: [],
    };
    const text = canonicalJson(authoring);
    const bytes = encoder.encode(text);
    const file = {path: "authoring.json", contentHash: sha256Hex(bytes), byteLength: bytes.byteLength};
    const manifest = {formatVersion: 1, migration, authoring: file, migrationHash: ZERO_HASH};
    manifest.migrationHash = computeMigrationHash(manifest);
    const published = {migration, migrationHash: manifest.migrationHash};
    const context = {
        async loadMigrationManifest(requested) {
            assert.equal(requested.migrationHash, published.migrationHash);
            return {ok: true, value: manifest};
        },
        async readMigrationFile(requested, requestedFile) {
            assert.equal(requested.migrationHash, published.migrationHash);
            if (requestedFile.path !== file.path) {
                return {ok: false, problems: [{field: null, messageKey: "migration.invalidReference", message: "migration.invalidReference", severity: "blocking", details: {path: requestedFile.path}}]};
            }
            return {ok: true, value: bytes};
        },
    };
    const runtime = {
        ...context,
        snapshots: {
            from: {snapshot: fromSnapshot, snapshotHash: fromSnapshotHash},
            to: {snapshot: toSnapshot, snapshotHash: toSnapshotHash},
        },
        nodeVersion: process.versions.node,
        async importValidationModule() {
            throw new Error("the T22 integration fixture has no validation module");
        },
    };
    return {published, context, runtime};
}

async function reset(session, sourceKind) {
    await session.query('DROP SCHEMA IF EXISTS "sd_journal" CASCADE', []);
    await session.query('DROP SCHEMA IF EXISTS "app" CASCADE', []);
    await session.query('CREATE SCHEMA "app"', []);
    if (sourceKind === "email") {
        await session.query('CREATE TABLE "app"."alumnos" ("alumno" integer PRIMARY KEY, "nombres" text NOT NULL, "email_anterior" text NULL, "nota_legacy" text NULL)', []);
        await session.query("INSERT INTO \"app\".\"alumnos\" (alumno,nombres,email_anterior,nota_legacy) VALUES (1,'Null',NULL,'retire'),(2,'Empty','','retire'),(3,'Value','uno@example.test','retire')", []);
    } else {
        await session.query('CREATE TABLE "app"."alumnos" ("alumno" integer PRIMARY KEY, "nombres" text NOT NULL)', []);
        await session.query("INSERT INTO \"app\".\"alumnos\" (alumno,nombres) VALUES (1,'One'),(2,'Two')", []);
    }
    const bootstrapped = await bootstrapJournal(session, JOURNAL);
    assert.equal(bootstrapped.ok, true, JSON.stringify(bootstrapped));
}

async function executeScenario(session, name, {fromSnapshot, toSnapshot, steps, after = [], decisions = []}) {
    const from = release(`${name}-A`);
    const to = release(`${name}-B`);
    const resources = Object.create(null);
    const migrationSteps = [];
    for (const step of steps) {
        const resolved = resource(step.id, step.sql);
        resources[resolved.ref.name] = resolved;
        migrationSteps.push({id: step.id, run: resolved.ref});
    }
    const afterRefs = [];
    for (const one of after) {
        const resolved = resource(one.id, one.sql, "check");
        resources[resolved.ref.name] = resolved;
        afterRefs.push(resolved.ref);
    }
    const migration = {
        id: `${name}-migration`,
        from,
        to,
        description: `${name} T22 PostgreSQL authoring integration`,
        before: [],
        steps: migrationSteps,
        after: afterRefs,
    };
    const artifact = authoringArtifact(migration, fromSnapshot, toSnapshot, decisions);
    const path = {from, to, migrations: [artifact.published]};
    const plan = await buildMigrationPlan(path, artifact.context);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    if (!plan.ok) throw new Error("plan did not build");

    const installationId = `installation-${name}`;
    const baseline = await installBaseline(session, JOURNAL, {installationId, scope: SCOPE, baseline: from});
    assert.equal(baseline.ok, true, JSON.stringify(baseline));

    const baseContext = {
        journal: JOURNAL,
        scope: SCOPE,
        resources,
        from: schemaState(),
        to: schemaState(),
        options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
        now: () => "2026-10-01T22:00:00.000Z",
    };
    const executed = await executeMigrationPath(session, path, (published) =>
        resolveMigrationExecutionContext(published, baseContext, artifact.runtime));
    return {executed, plan: plan.value, installationId, from, to};
}

async function columns(session) {
    const result = await session.query("SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='alumnos' ORDER BY ordinal_position", []);
    return result.rows.map((row) => row.column_name);
}

async function generatedOnly(session) {
    await reset(session, "add");
    const result = await executeScenario(session, "generated-only", {
        fromSnapshot: ADD_FROM,
        toSnapshot: ADD_TO,
        steps: [{id: "generated-add-email", sql: 'ALTER TABLE "app"."alumnos" ADD COLUMN "email" text NULL'}],
    });
    assert.equal(result.executed.ok, true, JSON.stringify(result.executed));
    assert.deepEqual(await columns(session), ["alumno", "nombres", "email"]);
}

async function manual(session) {
    await reset(session, "add");
    const result = await executeScenario(session, "manual", {
        fromSnapshot: ADD_FROM,
        toSnapshot: ADD_TO,
        steps: [{id: "manual-add-email", sql: 'ALTER TABLE "app"."alumnos" ADD COLUMN "email" text NULL'}],
    });
    assert.equal(result.executed.ok, true, JSON.stringify(result.executed));
    assert.deepEqual(await columns(session), ["alumno", "nombres", "email"]);
}

const LEGACY_DECISIONS = [
    {
        changeId: "fixture-email-transfer",
        source: {side: "from", entity: "alumnos", field: "email_anterior"},
        partitionCheck: null,
        resolution: {kind: "migrate", dataMigrationId: "move-email", outputs: ["email"]},
    },
    {
        changeId: "fixture-note-discard",
        source: {side: "from", entity: "alumnos", field: "nota_legacy"},
        partitionCheck: null,
        resolution: {kind: "discard", reason: "section-11 fixture intentionally retires nota_legacy"},
    },
];

async function mixed(session, blocking) {
    await reset(session, "email");
    const result = await executeScenario(session, blocking ? "rollback" : "mixed", {
        fromSnapshot: EMAIL_FROM,
        toSnapshot: EMAIL_TO,
        decisions: LEGACY_DECISIONS,
        steps: [
            {id: "generated-add-email", sql: 'ALTER TABLE "app"."alumnos" ADD COLUMN "email" text NULL'},
            {id: "manual-copy-email", sql: 'UPDATE "app"."alumnos" SET "email" = "email_anterior"'},
            {id: "generated-drop-email-anterior", sql: 'ALTER TABLE "app"."alumnos" DROP COLUMN "email_anterior" RESTRICT'},
            {id: "generated-drop-nota-legacy", sql: 'ALTER TABLE "app"."alumnos" DROP COLUMN "nota_legacy" RESTRICT'},
        ],
        after: blocking ? [{id: "force-rollback", sql: "SELECT false AS ok"}] : [],
    });

    if (!blocking) {
        assert.equal(result.executed.ok, true, JSON.stringify(result.executed));
        assert.deepEqual(await columns(session), ["alumno", "nombres", "email"]);
        const rows = await session.query('SELECT alumno, email FROM "app"."alumnos" ORDER BY alumno', []);
        assert.deepEqual(rows.rows.map((row) => [String(row.alumno), row.email]), [
            ["1", null],
            ["2", ""],
            ["3", "uno@example.test"],
        ]);
        return;
    }

    assert.equal(result.executed.ok, false, "blocking checkpoint must roll back the mixed migration");
    assert.deepEqual(await columns(session), ["alumno", "nombres", "email_anterior", "nota_legacy"]);

    let activationCount = 0;
    const binding = {
        deploymentId: "rollback-deployment",
        installationId: result.installationId,
        candidateApplicationHash: hashText("candidate"),
        planHash: result.plan.planHash,
        operation: "upgrade",
        from: result.from,
        to: result.to,
        engineVersion: "18.6",
        schemas: ["app"],
        configurationHash: hashText("configuration"),
        maintenanceId: "maintenance-rollback",
        production: false,
    };
    const gate = await checkDeploymentReady(binding, {
        session,
        journal: JOURNAL,
        maintenance: {async isActive() { return true; }},
        async finalChecks() { return {ok: true, value: true}; },
    });
    if (gate.ok) activationCount += 1;
    assert.equal(gate.ok, false, "failed migration must not be deployment-ready");
    assert.equal(activationCount, 0, "zero activations after rollback");
}

async function main() {
    const session = new PsqlSession({decodeValue: typedValue});
    try {
        await generatedOnly(session);
        process.stdout.write("T22 PostgreSQL authoring integration: generated-only passed\n");
        await manual(session);
        process.stdout.write("T22 PostgreSQL authoring integration: manual passed\n");
        await mixed(session, false);
        process.stdout.write("T22 PostgreSQL authoring integration: mixed passed\n");
        await mixed(session, true);
        process.stdout.write("T22 PostgreSQL authoring integration: rollback and zero activations passed\n");
    } finally {
        await session.close();
    }
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});

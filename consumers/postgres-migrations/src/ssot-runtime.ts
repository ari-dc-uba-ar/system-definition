import {readFile, readdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {
    canonicalJson, captureSystemSnapshot, decodeSystemSnapshot, isPlainObject, problem, sameReleaseRef, toJsonValue,
    type AnyEntityDef, type RecordCollection, type SystemEntityContext, type SystemSnapshotInput, type ValidationResult,
} from "system-definition";
import type {ClientConfig} from "pg";
import {describeReleaseArtifact, loadReleaseArtifact, publishReleaseArtifact, sha256Hex,
    type ReleaseArtifact, type ReleaseArtifactDraft} from "./artifact";
import {projectSchema, quotePgIdentifier, type PgTypeRepresentation, type StorageContext} from "./pg-schema";
import {generateCreate} from "./generate-create";
import {inspectSchema} from "./inspect-schema";
import {connectPostgres, createPostgresScratch} from "./pg-session";
import {verifyRelease} from "./verify";
import {bootstrapJournal, installBaseline, readHistory, readInstallation, withMigrationLock, startAttempt, finishAttempt, verifyHistory} from "./journal";
import {recordVerification, type DeploymentBindingInfo} from "./evidence";
import {executePublishedRelease, verifyPublishedRelease} from "./published-release";

export type PostgresSystemRuntime = {
    context: SystemEntityContext;
    definition: {
        systemId: string;
        entities: Readonly<Record<string, AnyEntityDef>>;
        records?: RecordCollection;
        schema?: string;
        typeMappings?: Readonly<Partial<Record<string, PgTypeRepresentation>>>;
    };
};

const hash = (text: string) => sha256Hex(new TextEncoder().encode(text));
const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const json = (value: unknown) => {
    const converted = toJsonValue(value);
    if (!converted.ok) throw new Error("Definition is not serializable");
    return canonicalJson(converted.value);
};
function unwrap<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
function failed(key: string, reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, key, "blocking", {reason})]};
}

export function postgresConnections(system: PostgresSystemRuntime) {
    const systemId = system.definition.systemId;
    const appUser = process.env.DATABASE_URL ? decodeURIComponent(new URL(process.env.DATABASE_URL).username)
        : process.env.PGUSER || systemId + "_user";
    const ownerUser = process.env.MIGRATION_DATABASE_URL ? decodeURIComponent(new URL(process.env.MIGRATION_DATABASE_URL).username)
        : process.env.MIGRATION_PGUSER || systemId + "_owner";
    if (!appUser || !ownerUser || appUser === ownerUser) throw new Error("Owner and app user must be distinct");
    const owner: ClientConfig = {connectionTimeoutMillis: 5000, user: ownerUser, database: process.env.PGDATABASE || systemId,
        ...(process.env.MIGRATION_PGPASSWORD ? {password: process.env.MIGRATION_PGPASSWORD} : {}),
        ...(process.env.MIGRATION_DATABASE_URL ? {connectionString: process.env.MIGRATION_DATABASE_URL} : {})};
    return {appUser, ownerUser, owner};
}

function snapshotOf(system: PostgresSystemRuntime) {
    const definition = system.definition;
    return unwrap(captureSystemSnapshot(system.context, {
        systemId: definition.systemId, entities: definition.entities, records: definition.records ?? system.context.records,
    } as SystemSnapshotInput<typeof system.context>));
}

/** Complete the declared model and access policy without generating SQL or reading files. */
function describePostgresSystem(system: PostgresSystemRuntime) {
    const definition = system.definition;
    const snapshot = snapshotOf(system);
    const schema = definition.schema ?? "ssot";
    const {appUser, ownerUser} = postgresConnections(system);
    const builtins: Record<string, PgTypeRepresentation> = {
        text: {schema: "pg_catalog", name: "text", modifiers: []},
        integer: {schema: "pg_catalog", name: "int4", modifiers: []},
        boolean: {schema: "pg_catalog", name: "bool", modifiers: []},
    };
    const physicalTypes: Record<string, PgTypeRepresentation> = {};
    for (const name of snapshot.typeNames) {
        const mapping = definition.typeMappings?.[name] ?? builtins[name];
        if (!mapping) throw new Error(`Declare typeMappings.${name} in the SSOT`);
        physicalTypes[name] = mapping;
    }
    const entities = Object.keys(snapshot.entities);
    const persistence = {entities, representations: {postgres: Object.fromEntries(snapshot.typeNames.map(name => [name,
        name === "integer" && !definition.typeMappings?.[name] ? "integer" : name === "boolean" && !definition.typeMappings?.[name] ? "boolean" : physicalTypes[name].name]))}};
    const tables = entities.map(name => quotePgIdentifier(schema) + "." + quotePgIdentifier(name)).join(", ");
    const grants = `GRANT USAGE ON SCHEMA ${quotePgIdentifier(schema)} TO ${quotePgIdentifier(appUser)};\n`
        + `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables} TO ${quotePgIdentifier(appUser)};\n`;
    const check = `SELECT
    current_user = ${literal(ownerUser)}
    AND has_schema_privilege(${literal(appUser)}, ${literal(schema)}, 'USAGE')
    AND NOT has_schema_privilege(${literal(appUser)}, ${literal(schema)}, 'CREATE')
    AND NOT pg_has_role(${literal(appUser)}, ${literal(ownerUser)}, 'MEMBER')
    AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(appUser)} AND (rolsuper OR rolcreatedb OR rolcreaterole))
    AND (SELECT count(*) = ${entities.length}
        AND bool_and(pg_get_userbyid(c.relowner) = ${literal(ownerUser)}
            AND has_table_privilege(${literal(appUser)}, c.oid, 'SELECT')
            AND has_table_privilege(${literal(appUser)}, c.oid, 'INSERT')
            AND has_table_privilege(${literal(appUser)}, c.oid, 'UPDATE')
            AND has_table_privilege(${literal(appUser)}, c.oid, 'DELETE'))
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${literal(schema)} AND c.relkind = 'r'
            AND c.relname IN (${entities.map(literal).join(', ')})) AS ok;\n`;
    const grantRef = {name: "app-grants", kind: "sql" as const, contentHash: hash(grants)};
    const checkRef = {name: "ownership-permissions", kind: "check" as const, contentHash: hash(check)};
    const storage: StorageContext = {schema, representation: "postgres", physicalTypes,
        environment: {engine: "postgresql", version: "18.6", serverVersionNum: 180006, encoding: "UTF8", collations: {}, externalDependencies: {}},
        resources: {"app-grants": {ref: grantRef, text: grants}, "ownership-permissions": {ref: checkRef, text: check}},
        createResources: [{id: "app-grants", run: grantRef, dependsOn: [], expectedObjects: []}], managedData: [], invariantChecks: [checkRef]};
    return {snapshot, persistence, storage};
}

/** The standard mappings are defaults; custom stored domains declare their mapping in the SSOT. */
export async function buildPostgresRelease(system: PostgresSystemRuntime, releaseId = "initial") {
    const {snapshot, persistence, storage} = describePostgresSystem(system);
    const schema = storage.schema;
    const grants = storage.resources["app-grants"].text;
    const check = storage.resources["ownership-permissions"].text;
    const checkRef = storage.invariantChecks[0];
    const projected = unwrap(projectSchema(snapshot, persistence, storage));
    const pgSchema = {formatVersion: projected.formatVersion, engineVersion: projected.engineVersion, schemas: projected.schemas, objects: projected.objects};
    const sql = unwrap(generateCreate(pgSchema)).statements.map(statement => statement.text + ";\n").join("");
    const createRef = {name: "create-tables", kind: "sql" as const, contentHash: hash(sql)};
    const version: {version: string} = JSON.parse(await readFile(join(__dirname, "../../package.json"), "utf8"));
    const provenance = async (name: string) => ({name, version: version.version, contentHash: sha256Hex(await readFile(join(__dirname, name + ".js")))});
    const draft: ReleaseArtifactDraft = {systemId: snapshot.systemId, releaseId, snapshot, persistence,
        schema: unwrap(toJsonValue(pgSchema)),
        createPlan: {formatVersion: 1, schema, generatedSql: [createRef], extraResources: storage.createResources.map(value => unwrap(toJsonValue(value))), dataResources: [], after: [checkRef]},
        resources: {"create-tables": {kind: "sql", path: "resources/create-tables.sql", text: sql},
            "app-grants": {kind: "sql", path: "resources/app-grants.sql", text: grants},
            "ownership-permissions": {kind: "check", path: "resources/ownership-permissions.sql", text: check}},
        invariantChecks: [checkRef.name], managedData: [], environment: storage.environment,
        generator: await provenance("generate-create"), inspector: await provenance("inspect-schema")};
    const manifest = unwrap(describeReleaseArtifact(draft));
    return {draft, release: {ref: manifest.release, snapshot, persistence, storage, inspection: {schemas: [schema], excluded: []}}};
}

export async function bootstrapPostgresSystem(system: PostgresSystemRuntime): Promise<ValidationResult<true>> {
    const {ownerUser, appUser} = postgresConnections(system);
    const adminUser = process.env.POSTGRES_USER || "postgres";
    if ([ownerUser, appUser].includes(adminUser)) return failed("migration.invalidExecutionOptions", "Bootstrap administrator, owner and app user must be distinct");
    const database = process.env.PGDATABASE || system.definition.systemId;
    const schema = system.definition.schema ?? "ssot";
    const admin = await connectPostgres({user: adminUser, password: process.env.POSTGRES_PASSWORD, database: "postgres", connectionTimeoutMillis: 5000});
    try {
        await admin.query("SET standard_conforming_strings = on", []);
        for (const [user, password, canCreate] of [[ownerUser, process.env.MIGRATION_PGPASSWORD, true], [appUser, process.env.PGPASSWORD, false]] as const) {
            const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
            if (!found.rows.length) await admin.query("CREATE ROLE " + quotePgIdentifier(user) + " LOGIN", []);
            await admin.query("ALTER ROLE " + quotePgIdentifier(user) + " LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION "
                + (canCreate ? "CREATEDB" : "NOCREATEDB") + (password ? " PASSWORD " + literal(password) : ""), []);
        }
        const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
        if (!found.rows.length) await admin.query("CREATE DATABASE " + quotePgIdentifier(database) + " OWNER " + quotePgIdentifier(ownerUser) + " ENCODING 'UTF8' TEMPLATE template0", []);
        else await admin.query("ALTER DATABASE " + quotePgIdentifier(database) + " OWNER TO " + quotePgIdentifier(ownerUser), []);
    } finally { await admin.close(); }
    const session = await connectPostgres(postgresConnections(system).owner);
    try {
        await session.query("BEGIN", []);
        await session.query("CREATE SCHEMA IF NOT EXISTS " + quotePgIdentifier(schema) + " AUTHORIZATION " + quotePgIdentifier(ownerUser), []);
        await session.query("ALTER SCHEMA " + quotePgIdentifier(schema) + " OWNER TO " + quotePgIdentifier(ownerUser), []);
        await session.query("REVOKE ALL ON SCHEMA " + quotePgIdentifier(schema) + " FROM PUBLIC", []);
        await session.query("REVOKE ALL ON SCHEMA " + quotePgIdentifier(schema) + " FROM " + quotePgIdentifier(appUser), []);
        await session.query("GRANT CONNECT ON DATABASE " + quotePgIdentifier(database) + " TO " + quotePgIdentifier(appUser), []);
        await session.query("GRANT USAGE ON SCHEMA " + quotePgIdentifier(schema) + " TO " + quotePgIdentifier(appUser), []);
        await session.query("COMMIT", []);
        return {ok: true, value: true};
    } finally { await session.close(); }
}

async function publishedSystem(system: PostgresSystemRuntime, root: string): Promise<ReleaseArtifact> {
    const current = describePostgresSystem(system);
    const projected = unwrap(projectSchema(current.snapshot, current.persistence, current.storage));
    const schema = {formatVersion: projected.formatVersion, engineVersion: projected.engineVersion, schemas: projected.schemas, objects: projected.objects};
    const entries = await readdir(join(root, "releases"), {withFileTypes: true});
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const artifact = unwrap(await loadReleaseArtifact(join(root, "releases", entry.name)));
        if (json(artifact.snapshot) === json(current.snapshot) && json(artifact.persistence) === json(current.persistence)
            && json(artifact.schema) === json(schema)
            && json(artifact.createPlan.extraResources) === json(current.storage.createResources)
            && json(artifact.manifest.invariantChecks) === json(current.storage.invariantChecks)) return artifact;
    }
    throw new Error("No published release matches the SSOT; publish it before installation");
}

/** Shared initial installation and verification. Later upgrades use the existing migration path runner. */
export async function installPostgresSystem(system: PostgresSystemRuntime, root = "migrations", checkOnly = false, connection?: ClientConfig) {
    const artifact = await publishedSystem(system, root);
    const owner = connection ?? postgresConnections(system).owner;
    const scope = {systemId: artifact.snapshot.systemId, schemas: [artifact.createPlan.schema]};
    const journal = {schema: "ssot_migrations"};
    return withMigrationLock({openTarget: () => connectPostgres(owner)}, scope, 10_000, async session => {
        const journalExists = await session.query("SELECT to_regclass($1)::text AS journal", [journal.schema + ".installation"]);
        const installation = journalExists.rows[0]?.journal ? unwrap(await readInstallation(session, journal, scope)) : null;
        if (installation) {
            if (!sameReleaseRef(installation.current, artifact.manifest.release)) return failed("migration.headMismatch", "Apply the published migration path to the requested release");
            unwrap(verifyHistory(installation, unwrap(await readHistory(session, journal, installation.installationId))));
            const checked = await verifyPublishedRelease(session, artifact);
            return checked.ok ? {ok: true, value: {installation, alreadyInstalled: true, verified: true}} : checked;
        }
        if (checkOnly) return failed("migration.notInstalled", "Install the initial release first");
        const observed = unwrap(await inspectSchema(session, {schemas: scope.schemas, excluded: []}));
        if (observed.schema.objects.length || observed.unknown.length) return failed("migration.baselineRequired", "Existing tables need an explicit baseline adoption");
        unwrap(await bootstrapJournal(session, journal));
        const installationId = randomUUID();
        const binding: DeploymentBindingInfo = {operation: "install", from: null, to: artifact.manifest.release,
            deploymentId: randomUUID(), installationId, candidateApplicationHash: artifact.manifest.snapshotHash,
            planHash: artifact.manifest.createPlan.contentHash, configurationHash: hash(json(scope)),
            engineVersion: "18.6", schemas: scope.schemas, maintenanceId: "initial-install", production: false};
        const clean = await verifyRelease({ref: artifact.manifest.release, snapshot: artifact.snapshot, persistence: artifact.persistence,
            storage: (await buildPostgresRelease(system, artifact.manifest.release.releaseId)).release.storage,
            inspection: {schemas: scope.schemas, excluded: []}}, createPostgresScratch(owner, scope.schemas));
        const checks = ["artifacts", "environment", "structure", "data"].map(kind => ({id: kind,
            kind: kind as "artifacts" | "environment" | "structure" | "data", status: clean.ok ? "passed" as const : "failed" as const,
            reportId: binding.deploymentId + ":" + kind, problems: clean.ok ? [] : clean.problems}));
        const recorded = await recordVerification(session, journal, {verificationId: randomUUID(), binding, checks, createdAt: new Date().toISOString()});
        if (!recorded.ok) return recorded;
        if (!clean.ok) return clean;
        const attempt = unwrap(await startAttempt(session, journal, {attemptId: randomUUID(), deploymentId: binding.deploymentId, installationId, planHash: binding.planHash}));
        await session.query("BEGIN", []);
        let commitSent = false;
        let outcome: ValidationResult<unknown>;
        try {
            unwrap(await executePublishedRelease(session, artifact));
            unwrap(await verifyPublishedRelease(session, artifact));
            const confirmed = unwrap(await installBaseline(session, journal, {installationId, scope, baseline: artifact.manifest.release}));
            commitSent = true;
            await session.query("COMMIT", []);
            outcome = {ok: true, value: {installation: confirmed, alreadyInstalled: false, verified: true}};
        } catch (error) {
            outcome = failed(commitSent ? "migration.unknownCommitOutcome" : "migration.executionFailed", error instanceof Error ? error.message : String(error));
        } finally { if (!commitSent) await session.query("ROLLBACK", []); }
        const finished = await finishAttempt(session, journal, attempt.attemptId, {state: outcome.ok ? "succeeded" : commitSent ? "unknown" : "failed",
            confirmedTarget: outcome.ok ? artifact.manifest.release : null, problems: outcome.ok ? [] : outcome.problems});
        return finished.ok ? outcome : finished;
    });
}

export async function runSsotCommand(command: string, file: string): Promise<ValidationResult<unknown>> {
    try {
        const module = await import(pathToFileURL(resolve(file)).href);
        const system: unknown = module.ssot ?? module.default?.ssot;
        if (!isPlainObject(system) || !isPlainObject(system.context) || !isPlainObject(system.definition)
            || typeof system.definition.systemId !== "string" || !isPlainObject(system.definition.entities)
            || typeof system.context.completeField !== "function" || !isPlainObject(system.context.types)
            || !isPlainObject(system.context.records) || !isPlainObject(system.context.behaviours)) {
            return failed("migration.invalidExecutionOptions", "SSOT module must export ssot = definePostgresSystem(context, definition)");
        }
        const input = system as unknown as PostgresSystemRuntime;
        if (command === "bootstrap") return bootstrapPostgresSystem(input);
        if (command === "capture") {
            return decodeSystemSnapshot(snapshotOf(input));
        }
        if (["build-release", "publish", "generate"].includes(command)) {
            const built = await buildPostgresRelease(input);
            const checked = await verifyRelease(built.release, createPostgresScratch(postgresConnections(input).owner, [built.release.storage.schema]));
            if (!checked.ok) return checked;
            if (command === "build-release") return {ok: true, value: built.draft};
            const published = await publishReleaseArtifact("migrations", built.draft);
            return published.ok ? {ok: true, value: {release: published.value.manifest.release,
                directory: "migrations/releases/" + published.value.manifest.release.releaseId, verified: true}} : published;
        }
        if (["install", "verify", "status"].includes(command)) return installPostgresSystem(input, "migrations", command !== "install");
        return failed("migration.invalidExecutionOptions", "This command requires a migration authoring project");
    } catch (error) { return failed("migration.executionFailed", error instanceof Error ? error.message : String(error)); }
}

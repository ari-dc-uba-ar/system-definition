import {isPlainObject, isSha256, problem, type ResourceRefInfo, type ValidationResult} from "system-definition";
import type {ReleaseArtifact} from "./artifact";
import {sha256Hex} from "./artifact";
import {checkManagedData} from "./managed-data";
import {inspectSchema} from "./inspect-schema";
import {compareSchemas} from "./compare-schema";
import {normalizePgSchema} from "./normalize-schema";
import {prepareCreateResources, validateExpectedObjects} from "./create-resources";
import {executePreparedSqlResource, prepareSqlResource, runCheckResource} from "./sql-resource";
import type {CreateResourceInfo, PgObjectIdentity, PgSchemaInfo, PgSession, StorageContext} from "./pg-schema";

function failure(reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {reason})]};
}

function resource(artifact: ReleaseArtifact, ref: ResourceRefInfo) {
    const found = artifact.resources[ref.name];
    if (!found || found.kind !== ref.kind || found.contentHash !== ref.contentHash
        || sha256Hex(new TextEncoder().encode(found.text)) !== ref.contentHash) {
        return {ok: false as const, problems: [problem(null, "migration.checksumMismatch", "blocking", {name: ref.name})]};
    }
    return {ok: true as const, value: {ref, text: found.text}};
}

function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}
function identity(value: unknown): value is PgObjectIdentity {
    return isPlainObject(value) && typeof value.schema === "string" && typeof value.name === "string"
        && ["table", "column", "constraint", "index", "view", "routine"].includes(String(value.kind))
        && (value.parentName === null || typeof value.parentName === "string") && strings(value.signature);
}
function createResource(value: unknown): value is CreateResourceInfo {
    return isPlainObject(value) && typeof value.id === "string" && strings(value.dependsOn)
        && Array.isArray(value.expectedObjects) && value.expectedObjects.every(identity)
        && isPlainObject(value.run) && typeof value.run.name === "string" && value.run.kind === "sql"
        && typeof value.run.contentHash === "string" && isSha256(value.run.contentHash);
}

/** Resolve the published plan and enforce dependencies and byte-addressed resources. */
function storageOf(artifact: ReleaseArtifact): ValidationResult<StorageContext> {
    if (!Array.isArray(artifact.createPlan.extraResources) || !artifact.createPlan.extraResources.every(createResource)) {
        return failure("invalid create resource plan");
    }
    const resources: StorageContext["resources"] = Object.fromEntries(Object.entries(artifact.resources).map(([name, entry]) => [
        name, {ref: {name, kind: entry.kind, contentHash: entry.contentHash}, text: entry.text},
    ]));
    return {ok: true, value: {
        schema: artifact.createPlan.schema, representation: "postgres", physicalTypes: {},
        environment: artifact.manifest.environment, resources, createResources: artifact.createPlan.extraResources,
        managedData: artifact.manifest.managedData, invariantChecks: artifact.manifest.invariantChecks,
    }};
}

/** Execute the published bytes. The caller owns the transaction and installation lock. */
export async function executePublishedRelease(session: PgSession, artifact: ReleaseArtifact): Promise<ValidationResult<true>> {
    const storage = storageOf(artifact);
    if (!storage.ok) return storage;
    const extras = prepareCreateResources(storage.value);
    if (!extras.ok) return extras;
    for (const ref of [...artifact.createPlan.generatedSql, ...extras.value.map(extra => extra.run), ...artifact.createPlan.dataResources]) {
        const loaded = resource(artifact, ref);
        if (!loaded.ok) return loaded;
        const prepared = prepareSqlResource(loaded.value);
        if (!prepared.ok) return prepared;
        const executed = await executePreparedSqlResource(session, prepared.value);
        if (!executed.ok) return executed;
    }
    return {ok: true, value: true};
}

/** Verify a live installation using its published schema; no scratch database needed. */
export async function verifyPublishedRelease(session: PgSession, artifact: ReleaseArtifact): Promise<ValidationResult<true>> {
    const encoding = await session.query("SHOW server_encoding", []);
    if (encoding.rows[0]?.server_encoding !== artifact.manifest.environment.encoding) {
        return {ok: false, problems: [problem(null, "migration.environmentMismatch", "blocking", {reason: "database encoding differs from the published environment"})]};
    }
    const storage = storageOf(artifact);
    if (!storage.ok) return storage;
    const expected = artifact.schema;
    if (!isPlainObject(expected) || expected.formatVersion !== 1 || !strings(expected.schemas) || !Array.isArray(expected.objects)) {
        return failure("invalid published schema");
    }
    const extras = prepareCreateResources(storage.value);
    if (!extras.ok) return extras;
    const observed = await inspectSchema(session, {schemas: expected.schemas, excluded: []});
    if (!observed.ok) return observed;
    const declared = validateExpectedObjects(extras.value, observed.value);
    if (!declared.ok) return declared;
    // PostgreSQL creates these indexes as part of the declared constraints.
    const relevant = {...observed.value, schema: {...observed.value.schema,
        objects: observed.value.schema.objects.filter(object => object.kind !== "index" || object.ownerConstraint === null)}};
    const compared = await compareSchemas(await normalizePgSchema(expected as unknown as PgSchemaInfo), {
        ...relevant, schema: await normalizePgSchema(relevant.schema),
    });
    if (!compared.ok) return compared;
    if (!compared.value.equal) return {ok: false, problems: [problem(null, "migration.schemaDrift", "blocking", {
        differences: JSON.stringify(compared.value.differences),
    })]};
    const data = await checkManagedData(session, storage.value.managedData);
    if (!data.ok) return data;
    const checks = new Map([...artifact.createPlan.after, ...storage.value.invariantChecks].map(ref => [ref.name, ref]));
    for (const ref of checks.values()) {
        const loaded = resource(artifact, ref);
        if (!loaded.ok) return loaded;
        const checked = await runCheckResource(session, loaded.value);
        if (!checked.ok) return checked;
    }
    return {ok: true, value: true};
}

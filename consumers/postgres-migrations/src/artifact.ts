import {join} from "node:path";
import {
    canonicalJson,
    decodeMigration,
    decodePersistence,
    decodeSystemSnapshot,
    hasExactKeys,
    isPlainObject,
    isSha256,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type MigrationContext,
    type MigrationInfo,
    type PersistenceInfo,
    type Problem,
    type ValidationResult,
    type ReleaseRefInfo,
    type ResourceInfo,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {canonicalJsonSha256, omitJsonObjectKeys, sha256Hex} from "./canonical-hash";
export {sha256Hex} from "./canonical-hash";
import {artifactExists, isSafeArtifactPath, openArtifactDirectory, publishArtifactDirectory,
    verifyArtifactPaths as verifyPathSet, type ArtifactDirectory} from "./artifact-files";
import {matchesPostgresSupport, POSTGRES_SUPPORT} from "./postgres-support";

export type EnvironmentInfo = {
    engine: typeof POSTGRES_SUPPORT.engine;
    version: typeof POSTGRES_SUPPORT.version;
    serverVersionNum: typeof POSTGRES_SUPPORT.serverVersionNum;
    encoding: string;
    collations: Readonly<Record<string, string>>;
    externalDependencies: Readonly<Record<string, string>>;
};

export type ManagedDataInfo = {
    table: {schema: string, name: string};
    key: readonly string[];
    columns: readonly string[];
    rows: readonly Readonly<Record<string, string | null>>[];
};

export type MigrationManifestInfo = {
    formatVersion: 1;
    migration: MigrationInfo;
    authoring: FileInfo;
    resources?: FileInfo;
    script?: FileInfo;
    migrationHash: string;
};

export type ReleaseManifestInfo = {
    formatVersion: 1;
    release: ReleaseRefInfo;
    snapshot: FileInfo;
    snapshotHash: string;
    persistence: FileInfo;
    schema: FileInfo;
    schemaHash: string;
    createPlan: FileInfo;
    resources: Readonly<Record<string, ResourceInfo>>;
    invariantChecks: readonly ResourceRefInfo[];
    managedData: readonly ManagedDataInfo[];
    environment: EnvironmentInfo;
    generator: {name: string, version: string, contentHash: string};
    inspector: {name: string, version: string, contentHash: string};
};

export type CreatePlanInfo = {
    formatVersion: 1;
    schema: string;
    generatedSql: readonly ResourceRefInfo[];
    extraResources: readonly JsonValue[];
    dataResources: readonly ResourceRefInfo[];
    after: readonly ResourceRefInfo[];
};

export type DraftResourceInfo = {
    kind: "sql" | "check";
    path: string;
    text: string;
};

export type ReleaseArtifactDraft = {
    systemId: string;
    releaseId: string;
    snapshot: SystemSnapshotInfo;
    persistence: {
        entities: readonly string[];
        representations: Record<string, Record<string, string>>;
    };
    schema: JsonValue;
    createPlan: CreatePlanInfo;
    resources: Record<string, DraftResourceInfo>;
    invariantChecks: readonly string[];
    managedData: readonly ManagedDataInfo[];
    environment: EnvironmentInfo;
    generator: {name: string, version: string, contentHash: string};
    inspector: {name: string, version: string, contentHash: string};
};

export type ResolvedArtifactResource = DraftResourceInfo & {
    contentHash: string;
};

export type ReleaseArtifact = {
    manifest: ReleaseManifestInfo;
    snapshot: SystemSnapshotInfo;
    persistence: PersistenceInfo;
    schema: JsonValue;
    createPlan: CreatePlanInfo;
    resources: Readonly<Record<string, ResolvedArtifactResource>>;
};

export type ArtifactProblem = Problem;
export type ArtifactResult<T> = ValidationResult<T>;

type JsonObject = {readonly [key: string]: JsonValue};

type PreparedFile = {
    path: string;
    bytes: Uint8Array;
    info: FileInfo;
    value: JsonValue;
};

type PreparedArtifact = {
    manifest: ReleaseManifestInfo;
    manifestBytes: Uint8Array;
    fixedFiles: readonly PreparedFile[];
    resources: Readonly<Record<string, {draft: DraftResourceInfo, bytes: Uint8Array, info: ResourceInfo}>>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal: true});

function failure<T>(messageKey: string, details: Readonly<Record<string, string>> = {}): ArtifactResult<T> {
    const p: ArtifactProblem = {
        field: null,
        messageKey,
        severity: "blocking",
        details,
    };
    return {ok: false, problems: [p]};
}

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}


function cloneJson<T>(value: T): ArtifactResult<T> {
    const converted = toJsonValue(value);
    if (!converted.ok) {
        const first = converted.problems[0];
        return failure(first?.messageKey ?? "migration.invalidJson", first?.details ?? {});
    }
    return {ok: true, value: converted.value as T};
}

export function canonicalBytes(value: unknown): ArtifactResult<{value: JsonValue, bytes: Uint8Array}> {
    const converted = toJsonValue(value);
    if (!converted.ok) {
        const first = converted.problems[0];
        return failure(first?.messageKey ?? "migration.invalidJson", first?.details ?? {});
    }
    return {
        ok: true,
        value: {value: converted.value, bytes: encoder.encode(canonicalJson(converted.value))},
    };
}

function hashableReleaseManifest(manifest: ReleaseManifestInfo): JsonValue {
    const converted = toJsonValue(manifest);
    if (!converted.ok || !isObject(converted.value) || !isObject(converted.value.release)) {
        throw new TypeError("release manifest is not strict JSON");
    }
    const result = omitJsonObjectKeys(converted.value, ["release"]);
    result.release = omitJsonObjectKeys(converted.value.release, ["releaseHash"]);
    return result;
}

export function computeReleaseHash(manifest: ReleaseManifestInfo): string {
    return canonicalJsonSha256(hashableReleaseManifest(manifest));
}

function hashableMigrationManifest(manifest: MigrationManifestInfo): JsonValue {
    const converted = toJsonValue(manifest);
    if (!converted.ok || !isObject(converted.value)) {
        throw new TypeError("migration manifest is not strict JSON");
    }
    return omitJsonObjectKeys(converted.value, ["migrationHash"]);
}

export function computeMigrationHash(manifest: MigrationManifestInfo): string {
    return canonicalJsonSha256(hashableMigrationManifest(manifest));
}

function isSafeOpaqueId(value: string): boolean {
    return value.length > 0
        && value !== "."
        && value !== ".."
        && !value.includes("/")
        && !value.includes("\\")
        && !value.includes("\0");
}

function verifySqlBytes(text: string, path: string): ArtifactResult<Uint8Array> {
    if (text.startsWith("\uFEFF")) return failure("migration.unsupportedFormat", {path, reason: "UTF-8 BOM is not allowed"});
    if (text.includes("\r")) return failure("migration.unsupportedFormat", {path, reason: "SQL must use LF line endings"});
    return {ok: true, value: encoder.encode(text)};
}

function prepareJsonFile(path: string, value: unknown): ArtifactResult<PreparedFile> {
    const encoded = canonicalBytes(value);
    if (!encoded.ok) return encoded;
    return {
        ok: true,
        value: {
            path,
            bytes: encoded.value.bytes,
            value: encoded.value.value,
            info: {path, contentHash: sha256Hex(encoded.value.bytes), byteLength: encoded.value.bytes.byteLength},
        },
    };
}

function checkEnvironment(environment: EnvironmentInfo): ArtifactResult<true> {
    if (!matchesPostgresSupport(environment)) {
        return failure("migration.environmentMismatch", {
            engine: String(environment.engine),
            version: String(environment.version),
            serverVersionNum: String(environment.serverVersionNum),
        });
    }
    return {ok: true, value: true};
}

function prepareArtifact(draft: ReleaseArtifactDraft): ArtifactResult<PreparedArtifact> {
    const detached = cloneJson(draft);
    if (!detached.ok) return detached;
    const source = detached.value;

    const decodedSnapshot = decodeSystemSnapshot(source.snapshot);
    if (!decodedSnapshot.ok) return decodedSnapshot;
    const decodedPersistence = decodePersistence(source.persistence, decodedSnapshot.value);
    if (!decodedPersistence.ok) return decodedPersistence;
    source.snapshot = decodedSnapshot.value;
    source.persistence = {
        entities: [...decodedPersistence.value.entities],
        representations: Object.fromEntries(
            Object.entries(decodedPersistence.value.representations).map(([name, mapping]) => [name, {...mapping}]),
        ),
    };

    if (!isSafeOpaqueId(source.systemId)) return failure("migration.invalidReference", {reason: "invalid system id"});
    if (!isSafeOpaqueId(source.releaseId)) return failure("migration.invalidReference", {reason: "invalid release id"});
    if (source.snapshot.systemId !== source.systemId) {
        return failure("migration.invalidReference", {reason: "snapshot system id differs from release system id"});
    }
    const environment = checkEnvironment(source.environment);
    if (!environment.ok) return environment;

    const snapshot = prepareJsonFile("snapshot.json", source.snapshot);
    if (!snapshot.ok) return snapshot;
    const persistence = prepareJsonFile("persistence.json", source.persistence);
    if (!persistence.ok) return persistence;
    const schema = prepareJsonFile("schema.json", source.schema);
    if (!schema.ok) return schema;
    const createPlan = prepareJsonFile("create-plan.json", source.createPlan);
    if (!createPlan.ok) return createPlan;
    const environmentFile = prepareJsonFile("environment.json", source.environment);
    if (!environmentFile.ok) return environmentFile;

    const resourceNames = Object.keys(source.resources).sort();
    const resources: Record<string, {draft: DraftResourceInfo, bytes: Uint8Array, info: ResourceInfo}> = Object.create(null);
    const allPaths = [
        "manifest.json",
        snapshot.value.path,
        persistence.value.path,
        schema.value.path,
        createPlan.value.path,
        environmentFile.value.path,
    ];
    for (const name of resourceNames) {
        if (!isSafeOpaqueId(name)) return failure("migration.invalidReference", {reason: "invalid resource name", name});
        const resource = source.resources[name];
        if (resource.kind !== "sql" && resource.kind !== "check") {
            return failure("migration.invalidResourceKind", {name, actual: String(resource.kind)});
        }
        const bytes = verifySqlBytes(resource.text, resource.path);
        if (!bytes.ok) return bytes;
        allPaths.push(resource.path);
        resources[name] = {
            draft: resource,
            bytes: bytes.value,
            info: {
                kind: resource.kind,
                file: {path: resource.path, contentHash: sha256Hex(bytes.value), byteLength: bytes.value.byteLength},
            },
        };
    }
    const safePaths = verifyPathSet(allPaths);
    if (!safePaths.ok) return safePaths;

    const invariantChecks: ResourceRefInfo[] = [];
    const seenChecks = new Set<string>();
    for (const name of source.invariantChecks) {
        if (seenChecks.has(name)) return failure("migration.invalidReference", {name, reason: "duplicate invariant check"});
        seenChecks.add(name);
        const resource = resources[name];
        if (resource === undefined) return failure("migration.invalidReference", {name, reason: "unknown invariant check"});
        if (resource.info.kind !== "check") {
            return failure("migration.invalidResourceKind", {name, expected: "check", actual: resource.info.kind});
        }
        invariantChecks.push({name, kind: "check", contentHash: resource.info.file.contentHash});
    }

    const manifestResources: Record<string, ResourceInfo> = Object.create(null);
    for (const name of resourceNames) manifestResources[name] = resources[name].info;

    const manifestBase: ReleaseManifestInfo = {
        formatVersion: 1,
        release: {systemId: source.systemId, releaseId: source.releaseId, releaseHash: "0".repeat(64)},
        snapshot: snapshot.value.info,
        snapshotHash: sha256Hex(snapshot.value.bytes),
        persistence: persistence.value.info,
        schema: schema.value.info,
        schemaHash: sha256Hex(schema.value.bytes),
        createPlan: createPlan.value.info,
        resources: manifestResources,
        invariantChecks,
        managedData: source.managedData,
        environment: source.environment,
        generator: source.generator,
        inspector: source.inspector,
    };
    const manifest: ReleaseManifestInfo = {
        ...manifestBase,
        release: {...manifestBase.release, releaseHash: computeReleaseHash(manifestBase)},
    };
    const manifestEncoded = canonicalBytes(manifest);
    if (!manifestEncoded.ok) return manifestEncoded;

    return {
        ok: true,
        value: {
            manifest,
            manifestBytes: manifestEncoded.value.bytes,
            fixedFiles: [snapshot.value, persistence.value, schema.value, createPlan.value, environmentFile.value],
            resources,
        },
    };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

/** Complete the immutable identity before verification, without writing files. */
export function describeReleaseArtifact(draft: ReleaseArtifactDraft): ArtifactResult<ReleaseManifestInfo> {
    const prepared = prepareArtifact(draft);
    return prepared.ok ? {ok: true, value: prepared.value.manifest} : prepared;
}

export async function publishReleaseArtifact(root: string, draft: ReleaseArtifactDraft): Promise<ArtifactResult<ReleaseArtifact>> {
    const prepared = prepareArtifact(draft);
    if (!prepared.ok) return prepared;

    try {
        const releasesDirectory = join(root, "releases");
        const finalDirectory = join(releasesDirectory, prepared.value.manifest.release.releaseId);
        if (await artifactExists(finalDirectory)) {
            const existing = await loadReleaseArtifact(finalDirectory);
            if (existing.ok && existing.value.manifest.release.releaseHash === prepared.value.manifest.release.releaseHash) {
                return existing;
            }
            return failure("migration.invalidCatalog", {
                releaseId: prepared.value.manifest.release.releaseId,
                reason: "published release id is immutable",
            });
        }

        const files = new Map<string, Uint8Array>(prepared.value.fixedFiles.map(file => [file.path, file.bytes]));
        for (const resource of Object.values(prepared.value.resources)) files.set(resource.draft.path, resource.bytes);
        files.set("manifest.json", prepared.value.manifestBytes);
        try {
            await publishArtifactDirectory(finalDirectory, files);
        } catch (error) {
            if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) {
                const existing = await loadReleaseArtifact(finalDirectory);
                if (existing.ok && existing.value.manifest.release.releaseHash === prepared.value.manifest.release.releaseHash) {
                    return existing;
                }
                return failure("migration.invalidCatalog", {
                    releaseId: prepared.value.manifest.release.releaseId,
                    reason: "published release id is immutable",
                });
            }
            throw error;
        }
        return loadReleaseArtifact(finalDirectory);
    } catch (error) {
        return failure("migration.invalidReference", {reason: error instanceof Error ? error.message : String(error)});
    }
}

export function parseJsonBytes(bytes: Uint8Array, path: string, requireCanonical = true): ArtifactResult<JsonValue> {
    let text: string;
    try {
        text = decoder.decode(bytes);
    } catch {
        return failure("migration.unsupportedFormat", {path, reason: "invalid UTF-8"});
    }
    if (text.startsWith("\uFEFF")) return failure("migration.unsupportedFormat", {path, reason: "UTF-8 BOM is not allowed"});
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        return failure("migration.invalidJson", {path, reason: error instanceof Error ? error.message : String(error)});
    }
    const converted = toJsonValue(parsed);
    if (!converted.ok) return failure("migration.invalidJson", {path, reason: "not strict JSON"});
    if (requireCanonical && canonicalJson(converted.value) !== text) {
        return failure("migration.checksumMismatch", {path, reason: "JSON artifact is not canonical"});
    }
    return {ok: true, value: converted.value};
}

export async function readArtifactJson(root: ArtifactDirectory, path: string, requireCanonical = true): Promise<ArtifactResult<JsonValue>> {
    const bytes = await root.read(path);
    return bytes.ok ? parseJsonBytes(bytes.value, path, requireCanonical) : bytes;
}

function decodeFileInfo(value: JsonValue, path: string): ArtifactResult<FileInfo> {
    if (!isObject(value)) return failure("migration.unsupportedFormat", {path, reason: "expected file info"});
    if (!hasExactKeys(value, ["byteLength", "contentHash", "path"])) return failure("migration.unsupportedFormat", {path, reason: "invalid file info shape"});
    if (typeof value.path !== "string" || !isSafeArtifactPath(value.path)) return failure("migration.invalidReference", {path, reason: "invalid file path"});
    if (typeof value.contentHash !== "string" || !isSha256(value.contentHash)) return failure("migration.unsupportedFormat", {path, reason: "invalid content hash"});
    if (typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
        return failure("migration.unsupportedFormat", {path, reason: "invalid byte length"});
    }
    return {ok: true, value: {path: value.path, contentHash: value.contentHash, byteLength: value.byteLength}};
}

function migrationContextFromSerialized(value: JsonValue): ArtifactResult<MigrationContext> {
    if (!isObject(value)) return failure("migration.unsupportedFormat", {reason: "invalid migration"});
    const expected = ["id", "from", "to", "description", "before", "steps", "after"].sort();
    if (!hasExactKeys(value, expected)) {
        return failure("migration.unsupportedFormat", {reason: "invalid migration shape"});
    }

    function release(raw: JsonValue, label: string): ArtifactResult<{systemId: string; releaseId: string; releaseHash: string}> {
        if (!isObject(raw) || !hasExactKeys(raw, ["releaseHash", "releaseId", "systemId"])
            || typeof raw.systemId !== "string" || !isSafeOpaqueId(raw.systemId)
            || typeof raw.releaseId !== "string" || !isSafeOpaqueId(raw.releaseId)
            || typeof raw.releaseHash !== "string" || !isSha256(raw.releaseHash)) {
            return failure("migration.unsupportedFormat", {reason: "invalid migration " + label + " release reference"});
        }
        return {ok: true, value: {systemId: raw.systemId, releaseId: raw.releaseId, releaseHash: raw.releaseHash}};
    }

    const from = release(value.from, "from");
    if (!from.ok) return from;
    const to = release(value.to, "to");
    if (!to.ok) return to;

    const resources: Record<string, {kind: "sql" | "check"; file: FileInfo}> = Object.create(null);
    function addResource(raw: JsonValue, expectedKind: "sql" | "check"): ArtifactResult<true> {
        if (!isObject(raw) || !hasExactKeys(raw, ["contentHash", "kind", "name"])
            || typeof raw.name !== "string" || !isSafeOpaqueId(raw.name)
            || raw.kind !== expectedKind
            || typeof raw.contentHash !== "string" || !isSha256(raw.contentHash)) {
            return failure("migration.unsupportedFormat", {reason: "invalid migration resource reference"});
        }
        const existing = resources[raw.name];
        if (existing !== undefined
            && (existing.kind !== expectedKind || existing.file.contentHash !== raw.contentHash)) {
            return failure("migration.invalidReference", {name: raw.name, reason: "inconsistent migration resource reference"});
        }
        resources[raw.name] = {
            kind: expectedKind,
            file: {path: "resources/" + raw.name, contentHash: raw.contentHash, byteLength: 0},
        };
        return {ok: true, value: true};
    }

    if (!Array.isArray(value.before) || !Array.isArray(value.after) || !Array.isArray(value.steps)) {
        return failure("migration.unsupportedFormat", {reason: "invalid migration resource lists"});
    }
    for (const raw of value.before) {
        const added = addResource(raw, "check");
        if (!added.ok) return added;
    }
    for (const raw of value.after) {
        const added = addResource(raw, "check");
        if (!added.ok) return added;
    }
    for (const raw of value.steps) {
        if (!isObject(raw) || !hasExactKeys(raw, ["id", "run"]) || typeof raw.id !== "string") {
            return failure("migration.unsupportedFormat", {reason: "invalid migration step"});
        }
        const added = addResource(raw.run, "sql");
        if (!added.ok) return added;
    }

    return {
        ok: true,
        value: {
            releases: {from: from.value, to: to.value},
            resources,
        },
    };
}

export function decodeMigrationManifest(value: JsonValue): ArtifactResult<MigrationManifestInfo> {
    if (!isObject(value)) return failure("migration.unsupportedFormat", {reason: "migration manifest must be an object"});
    const expected = ["formatVersion", "migration", "authoring", "migrationHash", ...(Object.hasOwn(value, "resources") ? ["resources"] : []), ...(Object.hasOwn(value, "script") ? ["script"] : [])].sort();
    if (!hasExactKeys(value, expected)) {
        return failure("migration.unsupportedFormat", {reason: "invalid migration manifest shape"});
    }
    if (value.formatVersion !== 1) return failure("migration.unsupportedFormat", {reason: "unsupported migration manifest format"});

    const authoring = decodeFileInfo(value.authoring, "manifest.authoring");
    if (!authoring.ok) return authoring;
    const resources = Object.hasOwn(value, "resources") ? decodeFileInfo(value.resources, "manifest.resources") : {ok: true as const, value: undefined};
    if (!resources.ok) return resources;
    const script = Object.hasOwn(value, "script") ? decodeFileInfo(value.script, "manifest.script") : {ok: true as const, value: undefined};
    if (!script.ok) return script;
    if (typeof value.migrationHash !== "string" || !isSha256(value.migrationHash)) {
        return failure("migration.unsupportedFormat", {reason: "invalid migration hash"});
    }

    const context = migrationContextFromSerialized(value.migration);
    if (!context.ok) return context;
    const migration = decodeMigration(value.migration, context.value);
    if (!migration.ok) return migration;

    const manifest: MigrationManifestInfo = {
        formatVersion: 1,
        migration: migration.value,
        authoring: authoring.value,
        ...(resources.value === undefined ? {} : {resources: resources.value}),
        ...(script.value === undefined ? {} : {script: script.value}),
        migrationHash: value.migrationHash,
    };
    if (computeMigrationHash(manifest) !== manifest.migrationHash) {
        return failure("migration.checksumMismatch", {reason: "migration hash mismatch"});
    }
    return {ok: true, value: manifest};
}

function decodeEnvironment(value: JsonValue): ArtifactResult<EnvironmentInfo> {
    if (!isObject(value)) return failure("migration.unsupportedFormat", {reason: "invalid environment"});
    const expected = ["engine", "version", "serverVersionNum", "encoding", "collations", "externalDependencies"].sort();
    if (!hasExactKeys(value, expected)) {
        return failure("migration.unsupportedFormat", {reason: "invalid environment shape"});
    }
    if (!matchesPostgresSupport(value)) {
        return failure("migration.environmentMismatch");
    }
    if (typeof value.encoding !== "string" || !isObject(value.collations) || !isObject(value.externalDependencies)) {
        return failure("migration.unsupportedFormat", {reason: "invalid environment"});
    }
    for (const item of Object.values(value.collations)) if (typeof item !== "string") return failure("migration.unsupportedFormat", {reason: "invalid collation"});
    for (const item of Object.values(value.externalDependencies)) if (typeof item !== "string") return failure("migration.unsupportedFormat", {reason: "invalid external dependency"});
    return {ok: true, value: value as EnvironmentInfo};
}

function decodeManifest(value: JsonValue): ArtifactResult<ReleaseManifestInfo> {
    if (!isObject(value)) return failure("migration.unsupportedFormat", {reason: "manifest must be an object"});
    const expected = [
        "formatVersion", "release", "snapshot", "snapshotHash", "persistence", "schema", "schemaHash", "createPlan",
        "resources", "invariantChecks", "managedData", "environment", "generator", "inspector",
    ].sort();
    if (!hasExactKeys(value, expected)) return failure("migration.unsupportedFormat", {reason: "invalid manifest shape"});
    if (value.formatVersion !== 1) return failure("migration.unsupportedFormat", {reason: "unsupported manifest format"});
    if (!isObject(value.release)
        || !hasExactKeys(value.release, ["releaseHash", "releaseId", "systemId"])
        || typeof value.release.systemId !== "string"
        || typeof value.release.releaseId !== "string"
        || typeof value.release.releaseHash !== "string"
        || !isSafeOpaqueId(value.release.systemId)
        || !isSafeOpaqueId(value.release.releaseId)
        || !isSha256(value.release.releaseHash)) {
        return failure("migration.unsupportedFormat", {reason: "invalid release reference"});
    }
    const snapshot = decodeFileInfo(value.snapshot, "manifest.snapshot");
    if (!snapshot.ok) return snapshot;
    const persistence = decodeFileInfo(value.persistence, "manifest.persistence");
    if (!persistence.ok) return persistence;
    const schema = decodeFileInfo(value.schema, "manifest.schema");
    if (!schema.ok) return schema;
    const createPlan = decodeFileInfo(value.createPlan, "manifest.createPlan");
    if (!createPlan.ok) return createPlan;
    if (snapshot.value.path !== "snapshot.json"
        || persistence.value.path !== "persistence.json"
        || schema.value.path !== "schema.json"
        || createPlan.value.path !== "create-plan.json") {
        return failure("migration.invalidReference", {reason: "release file path does not match versioned layout"});
    }
    if (typeof value.snapshotHash !== "string" || !isSha256(value.snapshotHash)
        || typeof value.schemaHash !== "string" || !isSha256(value.schemaHash)) {
        return failure("migration.unsupportedFormat", {reason: "invalid semantic hash"});
    }
    if (!isObject(value.resources)) return failure("migration.unsupportedFormat", {reason: "invalid resources"});
    const resources: Record<string, ResourceInfo> = Object.create(null);
    for (const [name, raw] of Object.entries(value.resources)) {
        if (!isSafeOpaqueId(name) || !isObject(raw)
            || !hasExactKeys(raw, ["file", "kind"])
            || (raw.kind !== "sql" && raw.kind !== "check")) {
            return failure("migration.unsupportedFormat", {reason: "invalid resource", name});
        }
        const file = decodeFileInfo(raw.file, "manifest.resources." + name);
        if (!file.ok) return file;
        resources[name] = {kind: raw.kind, file: file.value};
    }
    if (!Array.isArray(value.invariantChecks)) return failure("migration.unsupportedFormat", {reason: "invalid invariant checks"});
    const invariantChecks: ResourceRefInfo[] = [];
    const invariantNames = new Set<string>();
    for (const raw of value.invariantChecks) {
        if (!isObject(raw) || !hasExactKeys(raw, ["contentHash", "kind", "name"])
            || typeof raw.name !== "string" || raw.kind !== "check" || typeof raw.contentHash !== "string" || !isSha256(raw.contentHash)) {
            return failure("migration.unsupportedFormat", {reason: "invalid invariant check"});
        }
        if (invariantNames.has(raw.name)) return failure("migration.invalidReference", {name: raw.name, reason: "duplicate invariant check"});
        invariantNames.add(raw.name);
        const resource = resources[raw.name];
        if (resource === undefined) return failure("migration.invalidReference", {name: raw.name});
        if (resource.kind !== "check") return failure("migration.invalidResourceKind", {name: raw.name});
        if (resource.file.contentHash !== raw.contentHash) return failure("migration.checksumMismatch", {name: raw.name});
        invariantChecks.push({name: raw.name, kind: "check", contentHash: raw.contentHash});
    }
    if (!Array.isArray(value.managedData)) return failure("migration.unsupportedFormat", {reason: "invalid managed data"});
    const environment = decodeEnvironment(value.environment);
    if (!environment.ok) return environment;
    function decodeProducer(raw: JsonValue, label: string): ArtifactResult<{name: string, version: string, contentHash: string}> {
        if (!isObject(raw) || !hasExactKeys(raw, ["contentHash", "name", "version"])
            || typeof raw.name !== "string" || typeof raw.version !== "string" || typeof raw.contentHash !== "string" || !isSha256(raw.contentHash)) {
            return failure("migration.unsupportedFormat", {reason: "invalid " + label});
        }
        return {ok: true, value: {name: raw.name, version: raw.version, contentHash: raw.contentHash}};
    }
    const generator = decodeProducer(value.generator, "generator");
    if (!generator.ok) return generator;
    const inspector = decodeProducer(value.inspector, "inspector");
    if (!inspector.ok) return inspector;

    return {
        ok: true,
        value: {
            formatVersion: 1,
            release: value.release as ReleaseRefInfo,
            snapshot: snapshot.value,
            snapshotHash: value.snapshotHash,
            persistence: persistence.value,
            schema: schema.value,
            schemaHash: value.schemaHash,
            createPlan: createPlan.value,
            resources,
            invariantChecks,
            managedData: value.managedData as unknown as readonly ManagedDataInfo[],
            environment: environment.value,
            generator: generator.value,
            inspector: inspector.value,
        },
    };
}

async function loadVerifiedJsonFile(root: ArtifactDirectory, info: FileInfo): Promise<ArtifactResult<JsonValue>> {
    const bytes = await root.readVerified(info);
    if (!bytes.ok) return bytes;
    return parseJsonBytes(bytes.value, info.path);
}

export async function loadReleaseArtifact(directory: string): Promise<ArtifactResult<ReleaseArtifact>> {
    const root = await openArtifactDirectory(directory);
    if (!root.ok) return root;

    const manifestBytes = await root.value.read("manifest.json");
    if (!manifestBytes.ok) return manifestBytes;
    const manifestJson = parseJsonBytes(manifestBytes.value, "manifest.json");
    if (!manifestJson.ok) return manifestJson;
    const manifest = decodeManifest(manifestJson.value);
    if (!manifest.ok) return manifest;
    if (computeReleaseHash(manifest.value) !== manifest.value.release.releaseHash) {
        return failure("migration.checksumMismatch", {path: "manifest.json", reason: "release hash mismatch"});
    }

    const allPaths = [
        "manifest.json", "environment.json", manifest.value.snapshot.path, manifest.value.persistence.path,
        manifest.value.schema.path, manifest.value.createPlan.path,
        ...Object.values(manifest.value.resources).map(resource => resource.file.path),
    ];
    const paths = verifyPathSet(allPaths);
    if (!paths.ok) return paths;

    const snapshotJson = await loadVerifiedJsonFile(root.value, manifest.value.snapshot);
    if (!snapshotJson.ok) return snapshotJson;
    if (canonicalJsonSha256(snapshotJson.value) !== manifest.value.snapshotHash) {
        return failure("migration.checksumMismatch", {path: manifest.value.snapshot.path, reason: "snapshot hash mismatch"});
    }
    const persistenceJson = await loadVerifiedJsonFile(root.value, manifest.value.persistence);
    if (!persistenceJson.ok) return persistenceJson;
    const schemaJson = await loadVerifiedJsonFile(root.value, manifest.value.schema);
    if (!schemaJson.ok) return schemaJson;
    if (canonicalJsonSha256(schemaJson.value) !== manifest.value.schemaHash) {
        return failure("migration.checksumMismatch", {path: manifest.value.schema.path, reason: "schema hash mismatch"});
    }
    const createPlanJson = await loadVerifiedJsonFile(root.value, manifest.value.createPlan);
    if (!createPlanJson.ok) return createPlanJson;

    const environmentBytes = await root.value.read("environment.json");
    if (!environmentBytes.ok) return environmentBytes;
    const environmentExpected = canonicalBytes(manifest.value.environment);
    if (!environmentExpected.ok) return environmentExpected;
    if (sha256Hex(environmentBytes.value) !== sha256Hex(environmentExpected.value.bytes)
        || environmentBytes.value.byteLength !== environmentExpected.value.bytes.byteLength) {
        return failure("migration.checksumMismatch", {path: "environment.json"});
    }
    const environmentJson = parseJsonBytes(environmentBytes.value, "environment.json");
    if (!environmentJson.ok) return environmentJson;

    const resources: Record<string, ResolvedArtifactResource> = Object.create(null);
    for (const name of Object.keys(manifest.value.resources).sort()) {
        const info = manifest.value.resources[name];
        const bytes = await root.value.readVerified(info.file);
        if (!bytes.ok) return bytes;
        let text: string;
        try {
            text = decoder.decode(bytes.value);
        } catch {
            return failure("migration.unsupportedFormat", {path: info.file.path, reason: "invalid UTF-8"});
        }
        const sql = verifySqlBytes(text, info.file.path);
        if (!sql.ok) return sql;
        resources[name] = {kind: info.kind, path: info.file.path, text, contentHash: info.file.contentHash};
    }

    if (!isObject(snapshotJson.value) || !isObject(persistenceJson.value) || !isObject(createPlanJson.value)) {
        return failure("migration.unsupportedFormat", {reason: "release JSON files have invalid shapes"});
    }
    const decodedSnapshot = decodeSystemSnapshot(snapshotJson.value);
    if (!decodedSnapshot.ok) return decodedSnapshot;
    if (decodedSnapshot.value.systemId !== manifest.value.release.systemId) {
        return failure("migration.invalidReference", {reason: "snapshot system id differs from manifest release"});
    }
    const decodedPersistence = decodePersistence(persistenceJson.value, decodedSnapshot.value);
    if (!decodedPersistence.ok) return decodedPersistence;

    return {
        ok: true,
        value: {
            manifest: manifest.value,
            snapshot: decodedSnapshot.value,
            persistence: decodedPersistence.value,
            schema: schemaJson.value,
            createPlan: createPlanJson.value as unknown as CreatePlanInfo,
            resources,
        },
    };
}

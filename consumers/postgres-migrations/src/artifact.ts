import {createHash, randomBytes} from "node:crypto";
import {
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import {isAbsolute, join, relative, resolve, sep} from "node:path";
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
    type ReleaseRefInfo,
    type ResourceInfo,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {canonicalJsonSha256, omitJsonObjectKeys} from "./canonical-hash";
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

export type ArtifactProblem = Problem & {message: string};
export type ArtifactResult<T> =
    | {ok: true, value: T}
    | {ok: false, problems: readonly ArtifactProblem[]};

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
        message: messageKey,
        severity: "blocking",
        details,
    };
    return {ok: false, problems: [p]};
}

function coreFailure<T>(problems: readonly Problem[]): ArtifactResult<T> {
    return {
        ok: false,
        problems: problems.map(one => ({...one, message: one.messageKey})),
    };
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

function canonicalBytes(value: unknown): ArtifactResult<{value: JsonValue, bytes: Uint8Array}> {
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

export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
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

function isSafeArtifactPath(path: string): boolean {
    if (path.length === 0 || path.includes("\0") || path.includes("\\") || isAbsolute(path)) return false;
    if (/^[A-Za-z]:/.test(path) || path.startsWith("/")) return false;
    const pieces = path.split("/");
    return pieces.every(piece => piece.length > 0 && piece !== "." && piece !== "..");
}

function verifyPathSet(paths: readonly string[]): ArtifactResult<true> {
    const lower = new Map<string, string>();
    for (const path of paths) {
        if (!isSafeArtifactPath(path)) return failure("migration.invalidReference", {path, reason: "unsafe artifact path"});
        const key = path.toLowerCase();
        const existing = lower.get(key);
        if (existing !== undefined) {
            return failure("migration.invalidReference", {path, reason: "case-colliding artifact path", existing});
        }
        lower.set(key, path);
    }
    return {ok: true, value: true};
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
    if (!decodedSnapshot.ok) return coreFailure(decodedSnapshot.problems);
    const decodedPersistence = decodePersistence(source.persistence, decodedSnapshot.value);
    if (!decodedPersistence.ok) return coreFailure(decodedPersistence.problems);
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

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        return isNodeError(error) && error.code === "ENOENT" ? false : Promise.reject(error);
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

async function writePreparedDirectory(directory: string, prepared: PreparedArtifact): Promise<void> {
    await mkdir(directory, {recursive: false});
    try {
        for (const file of prepared.fixedFiles) {
            const fullPath = join(directory, ...file.path.split("/"));
            await mkdir(resolve(fullPath, ".."), {recursive: true});
            await writeFile(fullPath, file.bytes, {flag: "wx"});
        }
        for (const resource of Object.values(prepared.resources)) {
            const fullPath = join(directory, ...resource.draft.path.split("/"));
            await mkdir(resolve(fullPath, ".."), {recursive: true});
            await writeFile(fullPath, resource.bytes, {flag: "wx"});
        }
        await writeFile(join(directory, "manifest.json"), prepared.manifestBytes, {flag: "wx"});
    } catch (error) {
        await rm(directory, {recursive: true, force: true});
        throw error;
    }
}

export async function publishReleaseArtifact(root: string, draft: ReleaseArtifactDraft): Promise<ArtifactResult<ReleaseArtifact>> {
    const prepared = prepareArtifact(draft);
    if (!prepared.ok) return prepared;

    try {
        const releasesDirectory = join(root, "releases");
        await mkdir(releasesDirectory, {recursive: true});
        const finalDirectory = join(releasesDirectory, prepared.value.manifest.release.releaseId);
        if (await pathExists(finalDirectory)) {
            const existing = await loadReleaseArtifact(finalDirectory);
            if (existing.ok && existing.value.manifest.release.releaseHash === prepared.value.manifest.release.releaseHash) {
                return existing;
            }
            return failure("migration.invalidCatalog", {
                releaseId: prepared.value.manifest.release.releaseId,
                reason: "published release id is immutable",
            });
        }

        const tempDirectory = join(
            releasesDirectory,
            "." + prepared.value.manifest.release.releaseId + ".tmp-" + process.pid + "-" + randomBytes(8).toString("hex"),
        );
        await writePreparedDirectory(tempDirectory, prepared.value);
        try {
            await rename(tempDirectory, finalDirectory);
        } catch (error) {
            await rm(tempDirectory, {recursive: true, force: true});
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

async function verifyRootDirectory(directory: string): Promise<ArtifactResult<string>> {
    try {
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return failure("migration.invalidReference", {path: directory, reason: "release path must be a real directory"});
        }
        const real = await realpath(directory);
        if (resolve(real) !== resolve(directory)) {
            return failure("migration.invalidReference", {path: directory, reason: "release directory must not traverse a symlink"});
        }
        return {ok: true, value: real};
    } catch (error) {
        return failure("migration.invalidReference", {path: directory, reason: error instanceof Error ? error.message : String(error)});
    }
}

async function readSafeFile(rootReal: string, path: string): Promise<ArtifactResult<Uint8Array>> {
    if (!isSafeArtifactPath(path)) return failure("migration.invalidReference", {path, reason: "unsafe artifact path"});
    let current = rootReal;
    const parts = path.split("/");
    try {
        for (let index = 0; index < parts.length; index++) {
            current = join(current, parts[index]);
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) {
                return failure("migration.invalidReference", {path, reason: "artifact path traverses a symlink"});
            }
            if (index < parts.length - 1 && !stat.isDirectory()) {
                return failure("migration.invalidReference", {path, reason: "artifact parent is not a directory"});
            }
            if (index === parts.length - 1 && !stat.isFile()) {
                return failure("migration.invalidReference", {path, reason: "artifact is not a regular file"});
            }
        }
        const rel = relative(rootReal, current);
        if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) {
            return failure("migration.invalidReference", {path, reason: "artifact path escapes release directory"});
        }
        return {ok: true, value: await readFile(current)};
    } catch (error) {
        return failure("migration.invalidReference", {path, reason: error instanceof Error ? error.message : String(error)});
    }
}

function parseJsonBytes(bytes: Uint8Array, path: string): ArtifactResult<JsonValue> {
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
    if (canonicalJson(converted.value) !== text) {
        return failure("migration.checksumMismatch", {path, reason: "JSON artifact is not canonical"});
    }
    return {ok: true, value: converted.value};
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
    const expected = ["formatVersion", "migration", "authoring", "migrationHash"].sort();
    if (!hasExactKeys(value, expected)) {
        return failure("migration.unsupportedFormat", {reason: "invalid migration manifest shape"});
    }
    if (value.formatVersion !== 1) return failure("migration.unsupportedFormat", {reason: "unsupported migration manifest format"});

    const authoring = decodeFileInfo(value.authoring, "manifest.authoring");
    if (!authoring.ok) return authoring;
    if (typeof value.migrationHash !== "string" || !isSha256(value.migrationHash)) {
        return failure("migration.unsupportedFormat", {reason: "invalid migration hash"});
    }

    const context = migrationContextFromSerialized(value.migration);
    if (!context.ok) return context;
    const migration = decodeMigration(value.migration, context.value);
    if (!migration.ok) return coreFailure(migration.problems);

    const manifest: MigrationManifestInfo = {
        formatVersion: 1,
        migration: migration.value,
        authoring: authoring.value,
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

async function loadVerifiedJsonFile(root: string, info: FileInfo): Promise<ArtifactResult<JsonValue>> {
    const bytes = await readSafeFile(root, info.path);
    if (!bytes.ok) return bytes;
    if (bytes.value.byteLength !== info.byteLength || sha256Hex(bytes.value) !== info.contentHash) {
        return failure("migration.checksumMismatch", {path: info.path});
    }
    return parseJsonBytes(bytes.value, info.path);
}

export async function loadReleaseArtifact(directory: string): Promise<ArtifactResult<ReleaseArtifact>> {
    const root = await verifyRootDirectory(directory);
    if (!root.ok) return root;

    const manifestBytes = await readSafeFile(root.value, "manifest.json");
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

    const environmentBytes = await readSafeFile(root.value, "environment.json");
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
        const bytes = await readSafeFile(root.value, info.file.path);
        if (!bytes.ok) return bytes;
        if (bytes.value.byteLength !== info.file.byteLength || sha256Hex(bytes.value) !== info.file.contentHash) {
            return failure("migration.checksumMismatch", {path: info.file.path, name});
        }
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
    if (!decodedSnapshot.ok) return coreFailure(decodedSnapshot.problems);
    if (decodedSnapshot.value.systemId !== manifest.value.release.systemId) {
        return failure("migration.invalidReference", {reason: "snapshot system id differs from manifest release"});
    }
    const decodedPersistence = decodePersistence(persistenceJson.value, decodedSnapshot.value);
    if (!decodedPersistence.ok) return coreFailure(decodedPersistence.problems);

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

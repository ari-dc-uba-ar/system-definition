import {
    canonicalJson,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type MigrationInfo,
    type MigrationPathInfo,
    type MigrationPlanInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
} from "system-definition";
import {
    decodeMigrationManifest,
    sha256Hex,
    type ArtifactProblem,
    type ArtifactResult,
} from "./artifact";
import type {CompiledAuthoringInfo} from "./authoring";

type JsonObject = {readonly [key: string]: JsonValue};

const HASH_RE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {fatal: true});

export interface MigrationPlanArtifactContext {
    loadMigrationManifest(migration: PublishedMigrationInfo): Promise<ArtifactResult<JsonValue>>;
    readMigrationFile(migration: PublishedMigrationInfo, file: FileInfo): Promise<ArtifactResult<Uint8Array>>;
}

function failure<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ArtifactResult<T> {
    const one: ArtifactProblem = {
        field: null,
        messageKey,
        message: messageKey,
        severity: "blocking",
        details,
    };
    return {ok: false, problems: [one]};
}

function isObject(value: JsonValue): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameRelease(left: ReleaseRefInfo, right: ReleaseRefInfo): boolean {
    return left.systemId === right.systemId
        && left.releaseId === right.releaseId
        && left.releaseHash === right.releaseHash;
}

function jsonOf(value: unknown): JsonValue {
    const converted = toJsonValue(value);
    if (!converted.ok) throw new TypeError("migration plan is not strict JSON");
    return converted.value;
}

function sameJson(left: unknown, right: unknown): boolean {
    return canonicalJson(jsonOf(left)) === canonicalJson(jsonOf(right));
}

function hashablePlan(plan: MigrationPlanInfo): JsonValue {
    const converted = jsonOf(plan);
    if (!isObject(converted)) throw new TypeError("migration plan is not a JSON object");
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(converted)) {
        if (key !== "planHash") result[key] = value;
    }
    return result;
}

/** Hash the complete serialized migration plan except for its own hash field. */
export function computePlanHash(plan: MigrationPlanInfo): string {
    return sha256Hex(encoder.encode(canonicalJson(hashablePlan(plan))));
}

function decodeReleaseRef(value: JsonValue, label: string): ArtifactResult<ReleaseRefInfo> {
    if (!isObject(value)
        || Object.keys(value).sort().join(",") !== "releaseHash,releaseId,systemId"
        || typeof value.systemId !== "string"
        || typeof value.releaseId !== "string"
        || typeof value.releaseHash !== "string"
        || !HASH_RE.test(value.releaseHash)) {
        return failure("migration.unsupportedFormat", {reason: `invalid authoring ${label} release reference`});
    }
    return {
        ok: true,
        value: {
            systemId: value.systemId,
            releaseId: value.releaseId,
            releaseHash: value.releaseHash,
        },
    };
}

function decodeAuthoring(value: JsonValue): ArtifactResult<CompiledAuthoringInfo> {
    if (!isObject(value)) return failure("migration.unsupportedFormat", {reason: "authoring artifact must be an object"});
    const expected = [
        "formatVersion",
        "draftHash",
        "base",
        "migration",
        "operations",
        "decisions",
        "checkpoints",
        "queryResources",
        "validationArtifacts",
    ].sort();
    if (Object.keys(value).sort().join(",") !== expected.join(",") || value.formatVersion !== 1) {
        return failure("migration.unsupportedFormat", {reason: "invalid authoring artifact shape"});
    }
    if (typeof value.draftHash !== "string" || !HASH_RE.test(value.draftHash)) {
        return failure("migration.unsupportedFormat", {reason: "invalid authoring draft hash"});
    }
    if (!isObject(value.base)) return failure("migration.unsupportedFormat", {reason: "invalid authoring base"});
    const baseKeys = [
        "from",
        "to",
        "fromSnapshotHash",
        "toSnapshotHash",
        "fromPersistenceHash",
        "toPersistenceHash",
    ].sort();
    if (Object.keys(value.base).sort().join(",") !== baseKeys.join(",")) {
        return failure("migration.unsupportedFormat", {reason: "invalid authoring base shape"});
    }
    const from = decodeReleaseRef(value.base.from, "from");
    if (!from.ok) return from;
    const to = decodeReleaseRef(value.base.to, "to");
    if (!to.ok) return to;
    for (const key of ["fromSnapshotHash", "toSnapshotHash", "fromPersistenceHash", "toPersistenceHash"] as const) {
        const hash = value.base[key];
        if (typeof hash !== "string" || !HASH_RE.test(hash)) {
            return failure("migration.unsupportedFormat", {reason: `invalid authoring ${key}`});
        }
    }
    if (!Array.isArray(value.operations)
        || !Array.isArray(value.decisions)
        || !Array.isArray(value.checkpoints)
        || !isObject(value.queryResources)
        || !Array.isArray(value.validationArtifacts)
        || !isObject(value.migration)) {
        return failure("migration.unsupportedFormat", {reason: "invalid authoring payload shape"});
    }

    // T22 slice 2 needs a strict, detached JSON boundary and the exact endpoint
    // identity. Deeper authoring resources are resolved by later T22 slices.
    return {
        ok: true,
        value: {
            formatVersion: 1,
            draftHash: value.draftHash,
            base: {
                from: from.value,
                to: to.value,
                fromSnapshotHash: value.base.fromSnapshotHash as string,
                toSnapshotHash: value.base.toSnapshotHash as string,
                fromPersistenceHash: value.base.fromPersistenceHash as string,
                toPersistenceHash: value.base.toPersistenceHash as string,
            },
            migration: value.migration as unknown as MigrationInfo,
            operations: value.operations as unknown as CompiledAuthoringInfo["operations"],
            decisions: value.decisions as unknown as CompiledAuthoringInfo["decisions"],
            checkpoints: value.checkpoints,
            queryResources: value.queryResources as unknown as CompiledAuthoringInfo["queryResources"],
            validationArtifacts: value.validationArtifacts,
        },
    };
}

function parseCanonicalJson(bytes: Uint8Array, file: FileInfo): ArtifactResult<JsonValue> {
    if (bytes.byteLength !== file.byteLength || sha256Hex(bytes) !== file.contentHash) {
        return failure("migration.checksumMismatch", {path: file.path, reason: "authoring file metadata mismatch"});
    }

    let text: string;
    try {
        text = decoder.decode(bytes);
    } catch {
        return failure("migration.unsupportedFormat", {path: file.path, reason: "invalid UTF-8"});
    }
    if (text.startsWith("\uFEFF")) {
        return failure("migration.unsupportedFormat", {path: file.path, reason: "UTF-8 BOM is not allowed"});
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        return failure("migration.invalidJson", {path: file.path});
    }
    const converted = toJsonValue(parsed);
    if (!converted.ok) return failure("migration.invalidJson", {path: file.path, reason: "not strict JSON"});
    if (canonicalJson(converted.value) !== text) {
        return failure("migration.checksumMismatch", {path: file.path, reason: "JSON artifact is not canonical"});
    }
    return {ok: true, value: converted.value};
}

function validatePathEndpoints(path: MigrationPathInfo): ArtifactResult<true> {
    if (path.migrations.length === 0) {
        if (!sameRelease(path.from, path.to)) {
            return failure("migration.invalidReference", {reason: "empty migration path must preserve its endpoint"});
        }
        return {ok: true, value: true};
    }

    let expectedFrom = path.from;
    for (const published of path.migrations) {
        if (!sameRelease(published.migration.from, expectedFrom)) {
            return failure("migration.invalidReference", {migrationId: published.migration.id, reason: "migration path is not contiguous"});
        }
        expectedFrom = published.migration.to;
    }
    if (!sameRelease(expectedFrom, path.to)) {
        return failure("migration.invalidReference", {reason: "migration path destination mismatch"});
    }
    return {ok: true, value: true};
}

/**
 * Resolve the pure core migration path into an artifact-backed, hashed plan.
 * Every non-empty transition is reloaded from immutable storage and its exact
 * authoring artifact is verified before the plan identity is computed.
 */
export async function buildMigrationPlan(
    path: MigrationPathInfo,
    context: MigrationPlanArtifactContext,
): Promise<ArtifactResult<MigrationPlanInfo>> {
    const pathCheck = validatePathEndpoints(path);
    if (!pathCheck.ok) return pathCheck;

    const migrations: PublishedMigrationInfo[] = [];
    for (const published of path.migrations) {
        const loaded = await context.loadMigrationManifest(published);
        if (!loaded.ok) return loaded;
        const decoded = decodeMigrationManifest(loaded.value);
        if (!decoded.ok) return decoded;

        if (decoded.value.migrationHash !== published.migrationHash
            || !sameJson(decoded.value.migration, published.migration)) {
            return failure("migration.checksumMismatch", {
                migrationId: published.migration.id,
                reason: "published migration does not match immutable manifest",
            });
        }

        const bytes = await context.readMigrationFile(published, decoded.value.authoring);
        if (!bytes.ok) return bytes;
        const parsed = parseCanonicalJson(bytes.value, decoded.value.authoring);
        if (!parsed.ok) return parsed;
        const authoring = decodeAuthoring(parsed.value);
        if (!authoring.ok) return authoring;

        if (!sameRelease(authoring.value.base.from, decoded.value.migration.from)
            || !sameRelease(authoring.value.base.to, decoded.value.migration.to)) {
            return failure("migration.invalidReference", {
                migrationId: published.migration.id,
                reason: "authoring base does not match migration endpoints",
            });
        }
        if (!sameJson(authoring.value.migration, decoded.value.migration)) {
            return failure("migration.invalidReference", {
                migrationId: published.migration.id,
                reason: "authoring migration does not match immutable manifest",
            });
        }
        migrations.push(published);
    }

    const plan: MigrationPlanInfo = {
        formatVersion: 1,
        from: path.from,
        to: path.to,
        migrations,
        planHash: "0".repeat(64),
    };
    plan.planHash = computePlanHash(plan);
    return {ok: true, value: plan};
}

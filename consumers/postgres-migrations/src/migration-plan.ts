import {
    canonicalJson,
    decodeFileInfo,
    decodeArray,
    decodeFileResourceInfo,
    decodeContentRefInfo,
    type ValidationResult,
    hasExactKeys,
    isPlainObject,
    isSha256,
    sameReleaseRef,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type MigrationInfo,
    type MigrationPathInfo,
    type MigrationPlanInfo,
    type PublishedMigrationInfo,
} from "system-definition";
import {
    decodeMigrationManifest,
    parseJsonBytes,
    sha256Hex,
    type ArtifactProblem,
    type ArtifactResult,
    type MigrationManifestInfo,
} from "./artifact";
import {canonicalJsonSha256, omitJsonObjectKeys} from "./canonical-hash";
import {decodePortInfo} from "./data-authoring-codec";
import {decodeAuthoringBase, decodeDataDecisionInfo, type AuthoringCheckpointRowInfo, type CompiledAuthoringInfo} from "./authoring-contract";
import {decodeValidationArtifact} from "./validation-artifact";
import type {PortInfo} from "./migration-authoring";

type JsonObject = {readonly [key: string]: JsonValue};

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
        severity: "blocking",
        details,
    };
    return {ok: false, problems: [one]};
}

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}



function jsonOf(value: unknown): JsonValue {
    const converted = toJsonValue(value);
    if (!converted.ok) throw new TypeError("migration plan is not strict JSON");
    return converted.value;
}

function sameJson(left: unknown, right: unknown): boolean {
    return canonicalJson(jsonOf(left)) === canonicalJson(jsonOf(right));
}

/** Hash the complete serialized migration plan except for its own hash field. */
export function computePlanHash(plan: MigrationPlanInfo): string {
    return canonicalJsonSha256(omitJsonObjectKeys(jsonOf(plan), ["planHash"]));
}

const invalidAuthoring = (path: string, reason: string): ValidationResult<never> => failure("migration.unsupportedFormat", {path, reason});
const stringArray = (value: unknown, path: string) => decodeArray(value, path, invalidAuthoring,
    (raw, at) => typeof raw === "string" && raw.length > 0 ? {ok: true, value: raw} : invalidAuthoring(at, "expected a non-empty string"));
const checks = (value: unknown, path: string) => decodeArray(value, path, invalidAuthoring,
    (raw, at) => decodeContentRefInfo(raw, at, "check", invalidAuthoring));

function decodeRow(value: unknown, path: string): ValidationResult<AuthoringCheckpointRowInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["id", "afterStep", "side", "select", "validatorArtifactHash", Object.hasOwn(value, "entity") ? "entity" : "ports"])
        || typeof value.id !== "string" || value.id.length === 0 || typeof value.afterStep !== "string" || value.afterStep.length === 0
        || (value.side !== "from" && value.side !== "to") || !isSha256(value.validatorArtifactHash)) return invalidAuthoring(path, "invalid row checkpoint");
    const select = decodeContentRefInfo(value.select, path + ".select", "query", invalidAuthoring);
    if (!select.ok) return select;
    const common: Omit<AuthoringCheckpointRowInfo, "entity" | "ports"> = {id: value.id, afterStep: value.afterStep, side: value.side, select: select.value, validatorArtifactHash: value.validatorArtifactHash};
    if (Object.hasOwn(value, "entity")) return typeof value.entity === "string" && value.entity.length > 0
        ? {ok: true, value: {...common, entity: value.entity}} : invalidAuthoring(path, "expected an entity");
    if (!isPlainObject(value.ports)) return invalidAuthoring(path, "expected ports");
    const ports: Record<string, PortInfo> = Object.create(null);
    for (const [name, raw] of Object.entries(value.ports)) {
        if (name.length === 0) return invalidAuthoring(path, "empty port name");
        const port = decodePortInfo(raw, path + ".ports." + name, invalidAuthoring);
        if (!port.ok) return port;
        ports[name] = port.value;
    }
    return {ok: true, value: {...common, ports}};
}

function decodeAuthoring(value: JsonValue, migration: MigrationInfo): ArtifactResult<CompiledAuthoringInfo> {
    if (!isObject(value) || !hasExactKeys(value, ["formatVersion", "draftHash", "base", "migration", "operations", "decisions", "checkpoints", "queryResources", "validationArtifacts", ...(Object.hasOwn(value, "states") ? ["states"] : []), ...(Object.hasOwn(value, "initial") ? ["initial"] : [])])
        || value.formatVersion !== 1 || !isSha256(value.draftHash)) return invalidAuthoring("$", "invalid authoring shape");
    if (!sameJson(value.migration, migration)) return failure("migration.invalidReference", {reason: "authoring migration does not match immutable manifest"});
    const base = decodeAuthoringBase(value.base, "base", invalidAuthoring);
    if (!base.ok) return base;
    const operations = decodeArray(value.operations, "operations", invalidAuthoring, (raw, path): ValidationResult<CompiledAuthoringInfo["operations"][number]> => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["id", "stepIds", "changeIds", "dataMigrationIds"]) || typeof raw.id !== "string" || raw.id.length === 0) return invalidAuthoring(path, "invalid operation");
        const stepIds = stringArray(raw.stepIds, path + ".stepIds"); if (!stepIds.ok) return stepIds;
        const changeIds = stringArray(raw.changeIds, path + ".changeIds"); if (!changeIds.ok) return changeIds;
        const dataMigrationIds = stringArray(raw.dataMigrationIds, path + ".dataMigrationIds"); if (!dataMigrationIds.ok) return dataMigrationIds;
        return {ok: true, value: {id: raw.id, stepIds: stepIds.value, changeIds: changeIds.value, dataMigrationIds: dataMigrationIds.value}};
    });
    if (!operations.ok) return operations;
    const decisions = decodeArray(value.decisions, "decisions", invalidAuthoring, (raw, path) => decodeDataDecisionInfo(raw, path, invalidAuthoring));
    if (!decisions.ok) return decisions;
    const checkpoints = decodeArray(value.checkpoints, "checkpoints", invalidAuthoring, (raw, path): ValidationResult<CompiledAuthoringInfo["checkpoints"][number]> => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["afterStep", "checks", "rows"]) || typeof raw.afterStep !== "string" || raw.afterStep.length === 0) return invalidAuthoring(path, "invalid checkpoint");
        const checked = checks(raw.checks, path + ".checks"); if (!checked.ok) return checked;
        const rows = decodeArray(raw.rows, path + ".rows", invalidAuthoring, decodeRow); if (!rows.ok) return rows;
        return {ok: true, value: {afterStep: raw.afterStep, checks: checked.value, rows: rows.value}};
    });
    if (!checkpoints.ok) return checkpoints;
    if (!isObject(value.queryResources)) return invalidAuthoring("queryResources", "expected a query map");
    const queryResources: Record<string, CompiledAuthoringInfo["queryResources"][string]> = Object.create(null);
    for (const [name, raw] of Object.entries(value.queryResources)) {
        if (name.length === 0) return invalidAuthoring("queryResources", "empty query name");
        const decoded = decodeFileResourceInfo(raw, name, "query", invalidAuthoring); if (!decoded.ok) return decoded;
        queryResources[name] = decoded.value;
    }
    const validationArtifacts = decodeArray(value.validationArtifacts, "validationArtifacts", invalidAuthoring, decodeValidationArtifact);
    if (!validationArtifacts.ok) return validationArtifacts;
    let states: CompiledAuthoringInfo["states"];
    if (Object.hasOwn(value, "states")) {
        if (!isObject(value.states) || !hasExactKeys(value.states, ["from", "to"])) return invalidAuthoring("states", "invalid state references");
        const fromFile = decodeFileInfo(value.states.from, "states.from", invalidAuthoring); if (!fromFile.ok) return fromFile;
        const toFile = decodeFileInfo(value.states.to, "states.to", invalidAuthoring); if (!toFile.ok) return toFile;
        states = {from: fromFile.value, to: toFile.value};
    }
    const initial = Object.hasOwn(value, "initial") ? decodeContentRefInfo(value.initial, "initial", "sql", invalidAuthoring) : {ok: true as const, value: undefined};
    if (!initial.ok) return initial;
    return {ok: true, value: {formatVersion: 1, draftHash: value.draftHash,
        base: base.value,
        migration, operations: operations.value, decisions: decisions.value, checkpoints: checkpoints.value, queryResources,
        validationArtifacts: validationArtifacts.value, ...(states === undefined ? {} : {states}), ...(initial.value === undefined ? {} : {initial: initial.value})}};
}

function parseCanonicalJson(bytes: Uint8Array, file: FileInfo): ArtifactResult<JsonValue> {
    if (bytes.byteLength !== file.byteLength || sha256Hex(bytes) !== file.contentHash) {
        return failure("migration.checksumMismatch", {path: file.path, reason: "authoring file metadata mismatch"});
    }

    return parseJsonBytes(bytes, file.path);
}

function validatePathEndpoints(path: MigrationPathInfo): ArtifactResult<true> {
    if (path.migrations.length === 0) {
        if (!sameReleaseRef(path.from, path.to)) {
            return failure("migration.invalidReference", {reason: "empty migration path must preserve its endpoint"});
        }
        return {ok: true, value: true};
    }

    let expectedFrom = path.from;
    for (const published of path.migrations) {
        if (!sameReleaseRef(published.migration.from, expectedFrom)) {
            return failure("migration.invalidReference", {migrationId: published.migration.id, reason: "migration path is not contiguous"});
        }
        expectedFrom = published.migration.to;
    }
    if (!sameReleaseRef(expectedFrom, path.to)) {
        return failure("migration.invalidReference", {reason: "migration path destination mismatch"});
    }
    return {ok: true, value: true};
}

export type VerifiedMigrationAuthoring = {
    manifest: MigrationManifestInfo;
    authoring: CompiledAuthoringInfo;
};

/**
 * Re-resolve one published migration through immutable storage. Both planning
 * and runtime hydration use this function so neither can trust caller-supplied
 * migration or authoring bytes.
 */
export async function loadVerifiedMigrationAuthoring(
    published: PublishedMigrationInfo,
    context: MigrationPlanArtifactContext,
): Promise<ArtifactResult<VerifiedMigrationAuthoring>> {
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
    const authoring = decodeAuthoring(parsed.value, decoded.value.migration);
    if (!authoring.ok) return authoring;

    if (!sameReleaseRef(authoring.value.base.from, decoded.value.migration.from)
        || !sameReleaseRef(authoring.value.base.to, decoded.value.migration.to)) {
        return failure("migration.invalidReference", {
            migrationId: published.migration.id,
            reason: "authoring base does not match migration endpoints",
        });
    }
    return {ok: true, value: {manifest: decoded.value, authoring: authoring.value}};
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
        const verified = await loadVerifiedMigrationAuthoring(published, context);
        if (!verified.ok) return verified;
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

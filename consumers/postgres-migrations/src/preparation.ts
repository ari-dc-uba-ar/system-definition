import {createHash} from "node:crypto";
import {
    canonicalJson,
    problem,
    sameReleaseRef,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type ReleaseRefInfo,
    type ResourceInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {
    CompiledAuthoringInfo,
    DestructiveDecisionInfo,
    QueryResourceInfo,
} from "./authoring-contract";
import type {
    DomainRefInfo,
    FieldRefInfo,
    PortInfo,
    QueryRefInfo,
    SourceSelectionInfo,
} from "./migration-authoring";
import type {RehearsalCopyRef} from "./rehearsal";
import {
    executeMigrationPreparation,
    type MigrationExecutionContext,
} from "./execute-migration";
import {
    finishPreparationAttempt,
    readConfirmedPreparation,
    readPreparationHistory,
    recordConfirmedPreparation,
    startPreparationAttempt,
    withMigrationLock,
    type InstallationScope,
    type JournalConfig,
    type PgSessionFactory,
    type PreparationHistoryInfo,
} from "./journal";
import type {PgSession} from "./pg-schema";
import {
    decodeValidationArtifact,
    type ValidationArtifactInfo,
} from "./validation-artifact";

export type PreparationArtifactInfo = {
    formatVersion: 1;
    id: string;
    artifactHash: string;
    reportHash: string;
    installationId: string;
    head: ReleaseRefInfo;
    historyHash: string;
    observedSchemaHash: string;
    inputFingerprint: string;
    requestedPlanHash: string;
    steps: readonly {id: string; run: ResourceRefInfo}[];
    before: readonly ResourceRefInfo[];
    after: readonly ResourceRefInfo[];
    checkpoints: CompiledAuthoringInfo["checkpoints"];
    decisions: readonly DestructiveDecisionInfo[];
    resources: Readonly<Record<string, ResourceInfo>>;
    queryResources: CompiledAuthoringInfo["queryResources"];
    validationArtifacts: readonly ValidationArtifactInfo[];
    inputCapture: readonly SourceSelectionInfo[];
    expectedSchemaHash: string;
};

export type PreparationPreflightStateInfo = {
    copy: RehearsalCopyRef;
    installationId: string;
    head: ReleaseRefInfo;
    historyHash: string;
    observedSchemaHash: string;
    inputFingerprint: string;
    requestedPlanHash: string;
};


export type PreparationReceiptInfo = {
    preparationId: string;
    artifactHash: string;
    installationId: string;
    head: ReleaseRefInfo;
    inputFingerprint: string;
    status: "passed" | "failed" | "incomplete";
    checks: readonly {id: string; report: FileInfo; passed: boolean}[];
};

export type PreparationHistoryEntryInfo = {
    ordinal: number;
    preparationId: string;
    artifactHash: string;
    headReleaseHash: string;
    beforeFingerprint: string;
    afterFingerprint: string;
};

export type PreparationCurrentStateInfo = Omit<PreparationPreflightStateInfo, "copy">;

export type PreparationExecutionTarget =
    | {kind: "copy"; copy: RehearsalCopyRef}
    | {kind: "installation"; installationId: string};

export interface PreparationExecutionRuntime {
    journal: JournalConfig;
    scope: InstallationScope;
    sessions: PgSessionFactory;
    lockWaitTimeoutMs: number;
    inspectCopy(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        copy: RehearsalCopyRef,
    ): Promise<ValidationResult<PreparationPreflightStateInfo>>;
    inspectInstallation(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        installationId: string,
    ): Promise<ValidationResult<PreparationCurrentStateInfo>>;
    resolveExecutionContext(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        target: PreparationExecutionTarget,
    ): Promise<ValidationResult<MigrationExecutionContext>>;
    fingerprintInputs(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        target: PreparationExecutionTarget,
    ): Promise<ValidationResult<string>>;
    now(): string;
    attemptId(artifact: PreparationArtifactInfo): string;
}

type JsonObject = Readonly<Record<string, JsonValue>>;
type PreparationInput = Omit<PreparationArtifactInfo, "artifactHash">;

const HASH_RE = /^[0-9a-f]{64}$/;
const ARTIFACT_KEYS = [
    "formatVersion",
    "id",
    "artifactHash",
    "reportHash",
    "installationId",
    "head",
    "historyHash",
    "observedSchemaHash",
    "inputFingerprint",
    "requestedPlanHash",
    "steps",
    "before",
    "after",
    "checkpoints",
    "decisions",
    "resources",
    "queryResources",
    "validationArtifacts",
    "inputCapture",
    "expectedSchemaHash",
] as const;
const INPUT_KEYS = ARTIFACT_KEYS.filter(key => key !== "artifactHash");

function fail<T>(reason: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidPreparation", "blocking", {reason, ...details})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmpty(value: JsonValue): value is string {
    return typeof value === "string" && value.length > 0;
}

function hash(value: JsonValue): value is string {
    return typeof value === "string" && HASH_RE.test(value);
}

function decodeRelease(value: JsonValue): ValidationResult<ReleaseRefInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["systemId", "releaseId", "releaseHash"])
        || !nonEmpty(value.systemId)
        || !nonEmpty(value.releaseId)
        || !hash(value.releaseHash)) {
        return fail("invalid head release");
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

function decodeFileInfo(value: JsonValue, label: string): ValidationResult<FileInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["path", "contentHash", "byteLength"])
        || !nonEmpty(value.path)
        || !hash(value.contentHash)
        || typeof value.byteLength !== "number"
        || !Number.isSafeInteger(value.byteLength)
        || value.byteLength < 0) {
        return fail(`invalid ${label} file`);
    }
    return {
        ok: true,
        value: {path: value.path, contentHash: value.contentHash, byteLength: value.byteLength},
    };
}

function decodeResourceRef(
    value: JsonValue,
    expectedKind?: ResourceRefInfo["kind"],
): ValidationResult<ResourceRefInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["name", "kind", "contentHash"])
        || !nonEmpty(value.name)
        || !(value.kind === "sql" || value.kind === "check")
        || (expectedKind !== undefined && value.kind !== expectedKind)
        || !hash(value.contentHash)) {
        return fail("invalid resource reference");
    }
    return {ok: true, value: {name: value.name, kind: value.kind, contentHash: value.contentHash}};
}

function decodeQueryRef(value: JsonValue): ValidationResult<QueryRefInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["name", "kind", "contentHash"])
        || !nonEmpty(value.name)
        || value.kind !== "query"
        || !hash(value.contentHash)) {
        return fail("invalid query reference");
    }
    return {ok: true, value: {name: value.name, kind: "query", contentHash: value.contentHash}};
}

function decodeFieldRef(value: JsonValue): ValidationResult<FieldRefInfo | null> {
    if (value === null) return {ok: true, value: null};
    if (!isObject(value)
        || !exactKeys(value, ["side", "entity", "field"])
        || !(value.side === "from" || value.side === "to")
        || !nonEmpty(value.entity)
        || !nonEmpty(value.field)) {
        return fail("invalid field reference");
    }
    return {ok: true, value: {side: value.side, entity: value.entity, field: value.field}};
}

function decodeDomain(value: JsonValue): ValidationResult<DomainRefInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["side", "type", "nullable"])
        || !(value.side === "from" || value.side === "to")
        || !nonEmpty(value.type)
        || typeof value.nullable !== "boolean") {
        return fail("invalid domain reference");
    }
    return {ok: true, value: {side: value.side, type: value.type, nullable: value.nullable}};
}

function decodePort(value: JsonValue): ValidationResult<PortInfo> {
    if (!isObject(value) || !exactKeys(value, ["domain", "field"])) return fail("invalid port");
    const domain = decodeDomain(value.domain);
    if (!domain.ok) return domain;
    const field = decodeFieldRef(value.field);
    if (!field.ok) return field;
    if (field.value !== null && field.value.side !== domain.value.side) {
        return fail("port domain/field side mismatch");
    }
    return {ok: true, value: {domain: domain.value, field: field.value}};
}

function decodeSourceSelection(value: JsonValue): ValidationResult<SourceSelectionInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["query", "ports", "identity", "coverageChecks"])
        || !isObject(value.ports)
        || !Array.isArray(value.identity)
        || !Array.isArray(value.coverageChecks)) {
        return fail("invalid input capture");
    }
    const query = decodeQueryRef(value.query);
    if (!query.ok) return query;

    const ports: Record<string, PortInfo> = {};
    for (const [name, rawPort] of Object.entries(value.ports)) {
        if (name.length === 0) return fail("input capture port name is empty");
        const port = decodePort(rawPort);
        if (!port.ok) return port;
        ports[name] = port.value;
    }

    const identity: string[] = [];
    for (const rawName of value.identity) {
        if (!nonEmpty(rawName) || !(rawName in ports) || identity.includes(rawName)) {
            return fail("input capture identity must name distinct ports");
        }
        identity.push(rawName);
    }
    if (identity.length === 0) return fail("input capture requires identity ports");

    const coverageChecks: ResourceRefInfo[] = [];
    for (const rawCheck of value.coverageChecks) {
        const check = decodeResourceRef(rawCheck, "check");
        if (!check.ok) return check;
        coverageChecks.push(check.value);
    }
    if (coverageChecks.length === 0) return fail("input capture requires coverage checks");

    return {ok: true, value: {query: query.value, ports, identity, coverageChecks}};
}

function decodeResources(value: JsonValue): ValidationResult<Readonly<Record<string, ResourceInfo>>> {
    if (!isObject(value)) return fail("invalid resources map");
    const resources: Record<string, ResourceInfo> = {};
    for (const [name, rawResource] of Object.entries(value)) {
        if (name.length === 0
            || !isObject(rawResource)
            || !exactKeys(rawResource, ["kind", "file"])
            || !(rawResource.kind === "sql" || rawResource.kind === "check")) {
            return fail("invalid resource entry", {name});
        }
        const file = decodeFileInfo(rawResource.file, "resource");
        if (!file.ok) return file;
        resources[name] = {kind: rawResource.kind, file: file.value};
    }
    return {ok: true, value: resources};
}

function decodeQueryResources(value: JsonValue): ValidationResult<Readonly<Record<string, QueryResourceInfo>>> {
    if (!isObject(value)) return fail("invalid query resources map");
    const queries: Record<string, QueryResourceInfo> = {};
    for (const [name, rawQuery] of Object.entries(value)) {
        if (name.length === 0
            || !isObject(rawQuery)
            || !exactKeys(rawQuery, ["kind", "file"])
            || rawQuery.kind !== "query") {
            return fail("invalid query resource entry", {name});
        }
        const file = decodeFileInfo(rawQuery.file, "query resource");
        if (!file.ok) return file;
        queries[name] = {kind: "query", file: file.value};
    }
    return {ok: true, value: queries};
}

function decodeDecision(value: JsonValue): ValidationResult<DestructiveDecisionInfo> {
    if (!isObject(value)
        || !exactKeys(value, ["changeId", "source", "partitionCheck", "resolution"])
        || !nonEmpty(value.changeId)
        || !isObject(value.resolution)) {
        return fail("invalid destructive decision");
    }
    const source = decodeFieldRef(value.source);
    if (!source.ok) return source;
    let partitionCheck: ResourceRefInfo | null = null;
    if (value.partitionCheck !== null) {
        const decodedCheck = decodeResourceRef(value.partitionCheck, "check");
        if (!decodedCheck.ok) return decodedCheck;
        partitionCheck = decodedCheck.value;
    }

    let resolution: DestructiveDecisionInfo["resolution"];
    if (value.resolution.kind === "discard"
        && exactKeys(value.resolution, ["kind", "reason"])
        && nonEmpty(value.resolution.reason)) {
        resolution = {kind: "discard", reason: value.resolution.reason};
    } else if (value.resolution.kind === "migrate"
        && exactKeys(value.resolution, ["kind", "dataMigrationId", "outputs"])
        && nonEmpty(value.resolution.dataMigrationId)
        && Array.isArray(value.resolution.outputs)) {
        const outputs: string[] = [];
        for (const output of value.resolution.outputs) {
            if (!nonEmpty(output) || outputs.includes(output)) return fail("invalid migrate decision outputs");
            outputs.push(output);
        }
        if (outputs.length === 0) return fail("migrate decision requires outputs");
        resolution = {kind: "migrate", dataMigrationId: value.resolution.dataMigrationId, outputs};
    } else {
        return fail("invalid destructive resolution");
    }
    return {
        ok: true,
        value: {changeId: value.changeId, source: source.value, partitionCheck, resolution},
    };
}

function decodeSteps(value: JsonValue): ValidationResult<readonly {id: string; run: ResourceRefInfo}[]> {
    if (!Array.isArray(value)) return fail("invalid preparation steps");
    const steps: {id: string; run: ResourceRefInfo}[] = [];
    const ids = new Set<string>();
    for (const rawStep of value) {
        if (!isObject(rawStep)
            || !exactKeys(rawStep, ["id", "run"])
            || !nonEmpty(rawStep.id)
            || ids.has(rawStep.id)) {
            return fail("invalid preparation step");
        }
        const run = decodeResourceRef(rawStep.run, "sql");
        if (!run.ok) return run;
        ids.add(rawStep.id);
        steps.push({id: rawStep.id, run: run.value});
    }
    return {ok: true, value: steps};
}

function decodeResourceRefs(value: JsonValue, kind: ResourceRefInfo["kind"]): ValidationResult<readonly ResourceRefInfo[]> {
    if (!Array.isArray(value)) return fail("invalid resource reference list");
    const refs: ResourceRefInfo[] = [];
    for (const rawRef of value) {
        const ref = decodeResourceRef(rawRef, kind);
        if (!ref.ok) return ref;
        refs.push(ref.value);
    }
    return {ok: true, value: refs};
}

function decodeValidationArtifacts(value: JsonValue): ValidationResult<readonly ValidationArtifactInfo[]> {
    if (!Array.isArray(value)) return fail("invalid validation artifacts");
    const artifacts: ValidationArtifactInfo[] = [];
    for (const rawArtifact of value) {
        const decoded = decodeValidationArtifact(rawArtifact);
        if (!decoded.ok) return fail("invalid validation artifact");
        artifacts.push(decoded.value);
    }
    return {ok: true, value: artifacts};
}

function decodeCheckpoints(value: JsonValue): ValidationResult<CompiledAuthoringInfo["checkpoints"]> {
    if (!Array.isArray(value)) return fail("invalid checkpoints");
    // CompiledAuthoringInfo deliberately exposes checkpoints as unknown[] today.
    // Crossing this persisted boundary still requires strict JSON and a detached copy;
    // the runner performs the versioned semantic validation when the checkpoint is used.
    return {ok: true, value: value.map(one => one) as CompiledAuthoringInfo["checkpoints"]};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCopy(left: RehearsalCopyRef, right: RehearsalCopyRef): boolean {
    return left.copyId === right.copyId
        && left.provenance === right.provenance
        && left.installationId === right.installationId
        && sameReleaseRef(left.source, right.source)
        && sameStrings(left.schemas, right.schemas);
}

function validCopy(value: RehearsalCopyRef): boolean {
    return value.copyId.length > 0
        && value.provenance.length > 0
        && value.installationId.length > 0
        && value.schemas.length > 0
        && value.schemas.every(schema => schema.length > 0)
        && new Set(value.schemas).size === value.schemas.length;
}

function sameResource(ref: ResourceRefInfo, resources: Readonly<Record<string, ResourceInfo>>): boolean {
    const resource = resources[ref.name];
    return resource !== undefined
        && resource.kind === ref.kind
        && resource.file.contentHash === ref.contentHash;
}

function sameQuery(ref: QueryRefInfo, queryResources: Readonly<Record<string, QueryResourceInfo>>): boolean {
    const query = queryResources[ref.name];
    return query !== undefined && query.kind === "query" && query.file.contentHash === ref.contentHash;
}

function collectCheckpointRefs(checkpoints: CompiledAuthoringInfo["checkpoints"]): ValidationResult<{
    resources: readonly ResourceRefInfo[];
    queries: readonly QueryRefInfo[];
    validatorHashes: readonly string[];
}> {
    const converted = toJsonValue(checkpoints);
    if (!converted.ok || !Array.isArray(converted.value)) return fail("checkpoints must be strict JSON");
    const resources: ResourceRefInfo[] = [];
    const queries: QueryRefInfo[] = [];
    const validatorHashes: string[] = [];
    for (const rawCheckpoint of converted.value) {
        if (!isObject(rawCheckpoint)
            || !exactKeys(rawCheckpoint, ["afterStep", "checks", "rows"])
            || !nonEmpty(rawCheckpoint.afterStep)
            || !Array.isArray(rawCheckpoint.checks)
            || !Array.isArray(rawCheckpoint.rows)) {
            return fail("invalid checkpoint shape");
        }
        for (const rawCheck of rawCheckpoint.checks) {
            const check = decodeResourceRef(rawCheck, "check");
            if (!check.ok) return check;
            resources.push(check.value);
        }
        for (const rawRow of rawCheckpoint.rows) {
            if (!isObject(rawRow)
                || !exactKeys(rawRow, ["id", "afterStep", "side", "entity", "select", "validatorArtifactHash"])
                || !nonEmpty(rawRow.id)
                || !nonEmpty(rawRow.afterStep)
                || !(rawRow.side === "from" || rawRow.side === "to")
                || !nonEmpty(rawRow.entity)
                || !hash(rawRow.validatorArtifactHash)) {
                return fail("invalid checkpoint row");
            }
            const query = decodeQueryRef(rawRow.select);
            if (!query.ok) return query;
            queries.push(query.value);
            validatorHashes.push(rawRow.validatorArtifactHash);
        }
    }
    return {ok: true, value: {resources, queries, validatorHashes}};
}

function validationArtifactHash(artifact: ValidationArtifactInfo): string {
    const converted = toJsonValue(artifact);
    if (!converted.ok) throw new TypeError("validation artifact is not strict JSON");
    return createHash("sha256").update(canonicalJson(converted.value), "utf8").digest("hex");
}

function validateClosure(artifact: PreparationInput): ValidationResult<true> {
    const referencedResources: ResourceRefInfo[] = [
        ...artifact.before,
        ...artifact.steps.map(step => step.run),
        ...artifact.after,
    ];
    for (const decision of artifact.decisions) {
        if (decision.partitionCheck !== null) referencedResources.push(decision.partitionCheck);
    }
    for (const capture of artifact.inputCapture) {
        referencedResources.push(...capture.coverageChecks);
        if (!sameQuery(capture.query, artifact.queryResources)) {
            return fail("input capture query is not closed over queryResources", {query: capture.query.name});
        }
        if (capture.identity.length === 0) return fail("input capture cannot be count-only");
    }

    const checkpointRefs = collectCheckpointRefs(artifact.checkpoints);
    if (!checkpointRefs.ok) return checkpointRefs;
    referencedResources.push(...checkpointRefs.value.resources);
    for (const query of checkpointRefs.value.queries) {
        if (!sameQuery(query, artifact.queryResources)) {
            return fail("checkpoint query is not closed over queryResources", {query: query.name});
        }
    }
    if (checkpointRefs.value.validatorHashes.length > 0) {
        const available = new Set(artifact.validationArtifacts.map(validationArtifactHash));
        for (const validatorHash of checkpointRefs.value.validatorHashes) {
            if (!available.has(validatorHash)) {
                return fail("checkpoint validator artifact is not closed over validationArtifacts", {validatorHash});
            }
        }
    }

    for (const ref of referencedResources) {
        if (!sameResource(ref, artifact.resources)) {
            return fail("resource reference is not closed over resources", {resource: ref.name});
        }
    }
    return {ok: true, value: true};
}

function decodePreparation(
    value: unknown,
    expectedSchemaHash: string,
    includesHash: boolean,
): ValidationResult<PreparationArtifactInfo | PreparationInput> {
    const converted = toJsonValue(value);
    if (!converted.ok) return fail("preparation artifact must be strict JSON");
    const raw = converted.value;
    const keys = includesHash ? ARTIFACT_KEYS : INPUT_KEYS;
    if (!isObject(raw)
        || !exactKeys(raw, keys)
        || raw.formatVersion !== 1
        || !nonEmpty(raw.id)
        || (includesHash && !hash(raw.artifactHash))
        || !hash(raw.reportHash)
        || !nonEmpty(raw.installationId)
        || !hash(raw.historyHash)
        || !hash(raw.observedSchemaHash)
        || !hash(raw.inputFingerprint)
        || !hash(raw.requestedPlanHash)
        || !Array.isArray(raw.decisions)
        || !Array.isArray(raw.inputCapture)
        || !hash(raw.expectedSchemaHash)
        || raw.expectedSchemaHash !== expectedSchemaHash) {
        return fail("invalid preparation artifact shape");
    }

    const head = decodeRelease(raw.head);
    if (!head.ok) return head;
    const steps = decodeSteps(raw.steps);
    if (!steps.ok) return steps;
    const before = decodeResourceRefs(raw.before, "check");
    if (!before.ok) return before;
    const after = decodeResourceRefs(raw.after, "check");
    if (!after.ok) return after;
    const checkpoints = decodeCheckpoints(raw.checkpoints);
    if (!checkpoints.ok) return checkpoints;
    const resources = decodeResources(raw.resources);
    if (!resources.ok) return resources;
    const queryResources = decodeQueryResources(raw.queryResources);
    if (!queryResources.ok) return queryResources;
    const validationArtifacts = decodeValidationArtifacts(raw.validationArtifacts);
    if (!validationArtifacts.ok) return validationArtifacts;

    const decisions: DestructiveDecisionInfo[] = [];
    for (const rawDecision of raw.decisions) {
        const decision = decodeDecision(rawDecision);
        if (!decision.ok) return decision;
        decisions.push(decision.value);
    }
    const captures: SourceSelectionInfo[] = [];
    for (const rawCapture of raw.inputCapture) {
        const capture = decodeSourceSelection(rawCapture);
        if (!capture.ok) return capture;
        captures.push(capture.value);
    }
    if (captures.length === 0) return fail("preparation artifact requires inputCapture");

    const base: PreparationInput = {
        formatVersion: 1,
        id: raw.id,
        reportHash: raw.reportHash,
        installationId: raw.installationId,
        head: head.value,
        historyHash: raw.historyHash,
        observedSchemaHash: raw.observedSchemaHash,
        inputFingerprint: raw.inputFingerprint,
        requestedPlanHash: raw.requestedPlanHash,
        steps: steps.value,
        before: before.value,
        after: after.value,
        checkpoints: checkpoints.value,
        decisions,
        resources: resources.value,
        queryResources: queryResources.value,
        validationArtifacts: validationArtifacts.value,
        inputCapture: captures,
        expectedSchemaHash: raw.expectedSchemaHash,
    };
    const closed = validateClosure(base);
    if (!closed.ok) return closed;

    if (!includesHash) return {ok: true, value: base};
    const artifact: PreparationArtifactInfo = {
        ...base,
        artifactHash: raw.artifactHash as string,
    };
    if (artifact.artifactHash !== computePreparationArtifactHash(artifact)) {
        return fail("stale preparation artifact hash");
    }
    return {ok: true, value: artifact};
}

function hashableArtifact(artifact: PreparationArtifactInfo): JsonValue {
    const converted = toJsonValue(artifact);
    if (!converted.ok || !isObject(converted.value)) {
        throw new TypeError("preparation artifact is not strict JSON");
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(converted.value)) {
        if (key !== "artifactHash") result[key] = value;
    }
    return result;
}

export function computePreparationArtifactHash(artifact: PreparationArtifactInfo): string {
    return createHash("sha256").update(canonicalJson(hashableArtifact(artifact)), "utf8").digest("hex");
}

export function decodePreparationArtifact(
    value: unknown,
    headSchemaHash: string,
): ValidationResult<PreparationArtifactInfo> {
    if (!HASH_RE.test(headSchemaHash)) return fail("invalid head schema hash");
    const decoded = decodePreparation(value, headSchemaHash, true);
    return decoded as ValidationResult<PreparationArtifactInfo>;
}

export function createPreparationArtifact(
    input: PreparationInput,
    headSchemaHash: string,
): ValidationResult<PreparationArtifactInfo> {
    if (!HASH_RE.test(headSchemaHash)) return fail("invalid head schema hash");
    const decoded = decodePreparation(input, headSchemaHash, false);
    if (!decoded.ok) return decoded;
    const normalized = decoded.value as PreparationInput;
    const draft: PreparationArtifactInfo = {...normalized, artifactHash: "0".repeat(64)};
    const artifact: PreparationArtifactInfo = {...normalized, artifactHash: computePreparationArtifactHash(draft)};
    return {ok: true, value: artifact};
}

export function checkPreparationPreconditions(
    artifact: PreparationArtifactInfo,
    state: PreparationPreflightStateInfo,
): ValidationResult<true> {
    if (!validCopy(state.copy)) return fail("invalid identified copy");
    if (artifact.installationId !== state.installationId
        || state.copy.installationId !== artifact.installationId
        || !sameReleaseRef(state.copy.source, artifact.head)
        || !sameReleaseRef(state.head, artifact.head)
        || artifact.historyHash !== state.historyHash
        || artifact.observedSchemaHash !== state.observedSchemaHash
        || artifact.inputFingerprint !== state.inputFingerprint
        || artifact.requestedPlanHash !== state.requestedPlanHash) {
        return fail("preparation preconditions changed");
    }
    return {ok: true, value: true};
}

function checkCurrentPreparationPreconditions(
    artifact: PreparationArtifactInfo,
    state: PreparationCurrentStateInfo,
): ValidationResult<true> {
    if (artifact.installationId !== state.installationId
        || !sameReleaseRef(state.head, artifact.head)
        || artifact.historyHash !== state.historyHash
        || artifact.observedSchemaHash !== state.observedSchemaHash
        || artifact.inputFingerprint !== state.inputFingerprint
        || artifact.requestedPlanHash !== state.requestedPlanHash) {
        return fail("preparation preconditions changed");
    }
    return {ok: true, value: true};
}

function validReceipt(artifact: PreparationArtifactInfo, receipt: PreparationReceiptInfo): boolean {
    return receipt !== null && typeof receipt === "object"
        && receipt.preparationId === artifact.id
        && receipt.artifactHash === artifact.artifactHash
        && receipt.installationId === artifact.installationId
        && sameReleaseRef(receipt.head, artifact.head)
        && receipt.inputFingerprint === artifact.inputFingerprint
        && receipt.status === "passed"
        && Array.isArray(receipt.checks)
        && receipt.checks.every(check => check !== null && typeof check === "object"
            && typeof check.id === "string" && check.id.length > 0
            && typeof check.passed === "boolean"
            && check.report !== null && typeof check.report === "object");
}

function executionMigration(artifact: PreparationArtifactInfo) {
    return {
        id: artifact.id,
        from: artifact.head,
        to: artifact.head,
        description: `preparation ${artifact.id}`,
        before: artifact.before,
        steps: artifact.steps,
        after: artifact.after,
    };
}

function passedReceipt(artifact: PreparationArtifactInfo): PreparationReceiptInfo {
    return {
        preparationId: artifact.id,
        artifactHash: artifact.artifactHash,
        installationId: artifact.installationId,
        head: artifact.head,
        inputFingerprint: artifact.inputFingerprint,
        status: "passed",
        checks: [],
    };
}

function failedReceipt(artifact: PreparationArtifactInfo): PreparationReceiptInfo {
    return {
        preparationId: artifact.id,
        artifactHash: artifact.artifactHash,
        installationId: artifact.installationId,
        head: artifact.head,
        inputFingerprint: artifact.inputFingerprint,
        status: "failed",
        checks: [],
    };
}

function incompleteReceipt(artifact: PreparationArtifactInfo): PreparationReceiptInfo {
    return {
        preparationId: artifact.id,
        artifactHash: artifact.artifactHash,
        installationId: artifact.installationId,
        head: artifact.head,
        inputFingerprint: artifact.inputFingerprint,
        status: "incomplete",
        checks: [],
    };
}

export function computePreparationHistoryHash(
    history: readonly PreparationHistoryEntryInfo[],
): string {
    const converted = toJsonValue(history);
    if (!converted.ok) throw new TypeError("preparation history is not strict JSON");
    return createHash("sha256").update(canonicalJson(converted.value), "utf8").digest("hex");
}

export function preparationHistoryEntries(
    history: readonly PreparationHistoryInfo[],
): readonly PreparationHistoryEntryInfo[] {
    return history.map(one => ({
        ordinal: one.ordinal,
        preparationId: one.preparationId,
        artifactHash: one.artifactHash,
        headReleaseHash: one.head.releaseHash,
        beforeFingerprint: one.beforeFingerprint,
        afterFingerprint: one.afterFingerprint,
    }));
}

export async function readPreparationHistoryHash(
    session: PgSession,
    journal: JournalConfig,
    installationId: string,
): Promise<ValidationResult<string>> {
    const history = await readPreparationHistory(session, journal, installationId);
    if (!history.ok) return history;
    return {ok: true, value: computePreparationHistoryHash(preparationHistoryEntries(history.value))};
}

/** Verify a resolution only on an identified copy. It never confirms a preparation in the production journal. */
export async function verifyResolution(
    artifact: PreparationArtifactInfo,
    copy: RehearsalCopyRef,
    runtime: PreparationExecutionRuntime,
): Promise<ValidationResult<PreparationReceiptInfo>> {
    const decoded = decodePreparationArtifact(artifact, artifact.expectedSchemaHash);
    if (!decoded.ok) return decoded;
    const target: PreparationExecutionTarget = {kind: "copy", copy};
    return withMigrationLock(runtime.sessions, runtime.scope, runtime.lockWaitTimeoutMs, async session => {
        const state = await runtime.inspectCopy(session, decoded.value, copy);
        if (!state.ok) return state;
        const preflight = checkPreparationPreconditions(decoded.value, state.value);
        if (!preflight.ok) return preflight;
        const currentFingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
        if (!currentFingerprint.ok) return currentFingerprint;
        if (currentFingerprint.value !== decoded.value.inputFingerprint) {
            return fail("preparation input fingerprint changed");
        }
        const context = await runtime.resolveExecutionContext(session, decoded.value, target);
        if (!context.ok) return context;
        const executed = await executeMigrationPreparation(
            session,
            executionMigration(decoded.value),
            context.value,
        );
        if (!executed.ok) return executed;
        const afterFingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
        if (!afterFingerprint.ok) return afterFingerprint;
        return {ok: true, value: passedReceipt(decoded.value)};
    });
}

/**
 * Apply an already-verified resolution to the installation. A confirmed artifact is
 * an idempotent no-op only when the current fingerprint still equals the recorded
 * post-preparation fingerprint. Ambiguous COMMIT is reconciled from preparations.
 */
export async function applyResolution(
    artifact: PreparationArtifactInfo,
    receipt: PreparationReceiptInfo,
    runtime: PreparationExecutionRuntime,
): Promise<ValidationResult<PreparationReceiptInfo>> {
    const decoded = decodePreparationArtifact(artifact, artifact.expectedSchemaHash);
    if (!decoded.ok) return decoded;
    if (!validReceipt(decoded.value, receipt)) return fail("preparation receipt is incomplete or does not match artifact");
    const target: PreparationExecutionTarget = {kind: "installation", installationId: artifact.installationId};

    return withMigrationLock(runtime.sessions, runtime.scope, runtime.lockWaitTimeoutMs, async session => {
        const existing = await readConfirmedPreparation(
            session,
            runtime.journal,
            decoded.value.installationId,
            decoded.value.id,
        );
        if (!existing.ok) return existing;
        if (existing.value !== null) {
            if (existing.value.artifactHash !== decoded.value.artifactHash) {
                return fail("preparation id already confirmed for another artifact");
            }
            const fingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
            if (!fingerprint.ok) return fingerprint;
            if (fingerprint.value !== existing.value.afterFingerprint) {
                return fail("confirmed preparation state changed after success");
            }
            return {ok: true, value: passedReceipt(decoded.value)};
        }

        const state = await runtime.inspectInstallation(session, decoded.value, decoded.value.installationId);
        if (!state.ok) return state;
        const preflight = checkCurrentPreparationPreconditions(decoded.value, state.value);
        if (!preflight.ok) return preflight;
        const beforeFingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
        if (!beforeFingerprint.ok) return beforeFingerprint;
        if (beforeFingerprint.value !== decoded.value.inputFingerprint) {
            return fail("preparation input fingerprint changed");
        }

        const attemptId = runtime.attemptId(decoded.value);
        const started = await startPreparationAttempt(session, runtime.journal, {
            attemptId,
            installationId: decoded.value.installationId,
            preparationId: decoded.value.id,
            artifactHash: decoded.value.artifactHash,
            beforeFingerprint: beforeFingerprint.value,
            reportHash: decoded.value.reportHash,
        });
        if (!started.ok) return started;

        const context = await runtime.resolveExecutionContext(session, decoded.value, target);
        if (!context.ok) {
            await finishPreparationAttempt(session, runtime.journal, attemptId, {
                state: "failed",
                afterFingerprint: null,
                problems: context.problems,
            });
            return context;
        }

        let afterFingerprint: string | null = null;
        const executed = await executeMigrationPreparation(
            session,
            executionMigration(decoded.value),
            context.value,
            async transactionSession => {
                const captured = await runtime.fingerprintInputs(transactionSession, decoded.value, target);
                if (!captured.ok) return captured;
                afterFingerprint = captured.value;
                const committedAt = runtime.now();
                const recorded = await recordConfirmedPreparation(transactionSession, runtime.journal, {
                    installationId: decoded.value.installationId,
                    preparationId: decoded.value.id,
                    artifactHash: decoded.value.artifactHash,
                    head: decoded.value.head,
                    beforeFingerprint: beforeFingerprint.value,
                    afterFingerprint: captured.value,
                    reportHash: decoded.value.reportHash,
                    committedAt,
                });
                if (!recorded.ok) return recorded;
                return {ok: true, value: true};
            },
        );

        if (!executed.ok) {
            const unknown = executed.problems.some(one => one.messageKey === "migration.commitUnknown");
            if (unknown) {
                const reconciled = await readConfirmedPreparation(
                    session,
                    runtime.journal,
                    decoded.value.installationId,
                    decoded.value.id,
                );
                if (!reconciled.ok) return reconciled;
                if (reconciled.value !== null && reconciled.value.artifactHash === decoded.value.artifactHash) {
                    const finished = await finishPreparationAttempt(session, runtime.journal, attemptId, {
                        state: "succeeded",
                        afterFingerprint: reconciled.value.afterFingerprint,
                        problems: [],
                    });
                    if (!finished.ok) return finished;
                    return {ok: true, value: passedReceipt(decoded.value)};
                }
                await finishPreparationAttempt(session, runtime.journal, attemptId, {
                    state: "unknown",
                    afterFingerprint,
                    problems: executed.problems,
                });
                return executed;
            }
            await finishPreparationAttempt(session, runtime.journal, attemptId, {
                state: "failed",
                afterFingerprint,
                problems: executed.problems,
            });
            return executed;
        }

        const finished = await finishPreparationAttempt(session, runtime.journal, attemptId, {
            state: "succeeded",
            afterFingerprint,
            problems: [],
        });
        if (!finished.ok) return finished;
        return {ok: true, value: passedReceipt(decoded.value)};
    });
}

// Keep these constructors explicit so callers persisting diagnostic receipts can
// distinguish execution failure from an interrupted/incomplete verification.
export const preparationReceiptStatus = {
    passed: passedReceipt,
    failed: failedReceipt,
    incomplete: incompleteReceipt,
} as const;

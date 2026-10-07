import {
    decodeContentRefInfo as decodePackageContentRefInfo,
    decodeFileResourceInfo as decodePackageFileResourceInfo,
    decodeReleaseRefInfo as decodePackageReleaseRefInfo,
    decodeResourceRefInfo as decodePackageResourceRefInfo,
    toJsonValue,
    type JsonValue,
    type ReleaseRefInfo,
    type ResourceInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    decodeDestructiveDecisionInfo,
    type CompiledAuthoringInfo,
    type DestructiveDecisionInfo,
    type QueryResourceInfo,
} from "./authoring-contract";
import type {
    DomainRefInfo,
    FieldRefInfo,
    PortInfo,
    QueryRefInfo,
    SourceSelectionInfo,
} from "./migration-authoring";
import {
    decodeValidationArtifact,
    validationArtifactEvidenceHash,
    type ValidationArtifactInfo,
} from "./validation-artifact";
import {canonicalJsonSha256, omitJsonObjectKeys} from "./canonical-hash";
import {invalidPreparation as fail} from "./preparation-error";

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
    return decodePackageReleaseRefInfo(
        value,
        "preparation.head",
        () => fail<never>("invalid head release"),
    );
}

function decodeResourceRef(
    value: JsonValue,
    expectedKind?: ResourceRefInfo["kind"],
): ValidationResult<ResourceRefInfo> {
    const decoded = decodePackageResourceRefInfo(
        value,
        "preparation.resource",
        () => fail<never>("invalid resource reference"),
    );
    if (!decoded.ok) return decoded;
    if (expectedKind !== undefined && decoded.value.kind !== expectedKind) {
        return fail("invalid resource reference");
    }
    return decoded;
}

function decodeQueryRef(value: JsonValue): ValidationResult<QueryRefInfo> {
    return decodePackageContentRefInfo(
        value,
        "preparation.query",
        "query",
        () => fail<never>("invalid query reference"),
    );
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
        if (name.length === 0 || !isObject(rawResource) || !(rawResource.kind === "sql" || rawResource.kind === "check")) {
            return fail("invalid resource entry", {name});
        }
        const decoded = decodePackageFileResourceInfo(
            rawResource,
            `preparation.resources[${JSON.stringify(name)}]`,
            rawResource.kind,
            (path, reason) => fail("invalid resource entry", {name, path, reason}),
        );
        if (!decoded.ok) return decoded;
        resources[name] = decoded.value;
    }
    return {ok: true, value: resources};
}

function decodeQueryResources(value: JsonValue): ValidationResult<Readonly<Record<string, QueryResourceInfo>>> {
    if (!isObject(value)) return fail("invalid query resources map");
    const queries: Record<string, QueryResourceInfo> = {};
    for (const [name, rawQuery] of Object.entries(value)) {
        if (name.length === 0) return fail("invalid query resource entry", {name});
        const decoded = decodePackageFileResourceInfo(
            rawQuery,
            `preparation.queryResources[${JSON.stringify(name)}]`,
            "query",
            (path, reason) => fail("invalid query resource entry", {name, path, reason}),
        );
        if (!decoded.ok) return decoded;
        queries[name] = decoded.value;
    }
    return {ok: true, value: queries};
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
        const available = new Set(artifact.validationArtifacts.map(validationArtifactEvidenceHash));
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
    for (let index = 0; index < raw.decisions.length; index++) {
        const decision = decodeDestructiveDecisionInfo(
            raw.decisions[index],
            `preparation["decisions"][${index}]`,
            (_path, reason) => fail(reason),
        );
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
    return omitJsonObjectKeys(converted.value, ["artifactHash"]);
}

export function computePreparationArtifactHash(artifact: PreparationArtifactInfo): string {
    return canonicalJsonSha256(hashableArtifact(artifact));
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

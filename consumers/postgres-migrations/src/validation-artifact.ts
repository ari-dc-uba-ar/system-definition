import {createHash} from "node:crypto";
import {
    decodeFileInfo,
    exactKeys,
    isPlainObject,
    isSha256,
    problem,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type Problem,
    type ValidationResult,
} from "system-definition";
import {canonicalJsonSha256} from "./canonical-hash";
import type {PortInfo, SnapshotSide} from "./migration-authoring";

export type ValidationArtifactInfo = {
    formatVersion: 1;
    side: SnapshotSide;
    snapshotHash: string;
    entry: FileInfo;
    runtime: {
        nodeVersion: string;
        abi: "migration-validation-1";
    };
    domainContractHashes: Readonly<Record<string, string>>;
    entityValidatorNames: Readonly<Record<string, readonly string[]>>;
};

export interface ValidationModule {
    abi: "migration-validation-1";
    snapshotHash: string;
    validatePorts(
        ports: Readonly<Record<string, PortInfo>>,
        values: Readonly<Record<string, string | null>>,
    ): readonly Problem[];
    validateEntityRow(
        entity: string,
        values: Readonly<Record<string, string | null>>,
    ): readonly Problem[];
}

export type ValidationArtifactHost = {
    nodeVersion: string;
    readEntry(entry: FileInfo): Promise<Uint8Array>;
    importModule(entry: FileInfo, cacheIdentity: string): Promise<unknown>;
};

type JsonObject = Readonly<Record<string, JsonValue>>;

const encoder = new TextEncoder();

function invalid<T>(reason: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.validationArtifactInvalid", "blocking", {reason, ...details})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}

function invalidEntry(path: string, _reason: string): ValidationResult<never> {
    if (path.endsWith('["path"]')) return invalid("invalid entry path");
    if (path.endsWith('["contentHash"]')) return invalid("invalid entry content hash");
    if (path.endsWith('["byteLength"]')) return invalid("invalid entry byte length");
    return invalid("invalid entry shape");
}

function decodeHashMap(value: JsonValue, label: string): ValidationResult<Readonly<Record<string, string>>> {
    if (!isObject(value)) return invalid(`invalid ${label} shape`);
    const decoded: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, rawHash] of Object.entries(value)) {
        if (name.length === 0 || !isSha256(rawHash)) return invalid(`invalid ${label} entry`, {name});
        decoded[name] = rawHash;
    }
    return {ok: true, value: decoded};
}

function decodeValidatorNames(value: JsonValue): ValidationResult<Readonly<Record<string, readonly string[]>>> {
    if (!isObject(value)) return invalid("invalid entity validator names shape");
    const decoded: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
    for (const [entity, rawNames] of Object.entries(value)) {
        if (entity.length === 0 || !Array.isArray(rawNames)) return invalid("invalid entity validator names entry", {entity});
        const names: string[] = [];
        for (const rawName of rawNames) {
            if (typeof rawName !== "string" || rawName.length === 0) {
                return invalid("invalid validator name", {entity});
            }
            names.push(rawName);
        }
        decoded[entity] = names;
    }
    return {ok: true, value: decoded};
}

export function decodeValidationArtifact(value: unknown): ValidationResult<ValidationArtifactInfo> {
    const copied = toJsonValue(value);
    if (!copied.ok) return {ok: false, problems: copied.problems};
    const raw = copied.value;
    if (!isObject(raw)) return invalid("invalid artifact shape");
    const artifactShape = exactKeys(raw, [
        "formatVersion",
        "side",
        "snapshotHash",
        "entry",
        "runtime",
        "domainContractHashes",
        "entityValidatorNames",
    ], "$", () => invalid("invalid artifact shape"));
    if (!artifactShape.ok) return artifactShape;
    if (raw.formatVersion !== 1) return invalid("unsupported format version");
    if (raw.side !== "from" && raw.side !== "to") return invalid("invalid snapshot side");
    if (!isSha256(raw.snapshotHash)) return invalid("invalid snapshot hash");

    const entry = decodeFileInfo(raw.entry, '$["entry"]', invalidEntry);
    if (!entry.ok) return entry;

    if (!isObject(raw.runtime)) return invalid("invalid runtime shape");
    const runtimeShape = exactKeys(raw.runtime, ["nodeVersion", "abi"], '$["runtime"]', () => invalid("invalid runtime shape"));
    if (!runtimeShape.ok) return runtimeShape;
    if (typeof raw.runtime.nodeVersion !== "string" || raw.runtime.nodeVersion.length === 0) {
        return invalid("invalid node runtime");
    }
    if (raw.runtime.abi !== "migration-validation-1") return invalid("unsupported validation ABI");

    const domainContractHashes = decodeHashMap(raw.domainContractHashes, "domain contract hashes");
    if (!domainContractHashes.ok) return domainContractHashes;
    const entityValidatorNames = decodeValidatorNames(raw.entityValidatorNames);
    if (!entityValidatorNames.ok) return entityValidatorNames;

    return {
        ok: true,
        value: {
            formatVersion: 1,
            side: raw.side,
            snapshotHash: raw.snapshotHash,
            entry: entry.value,
            runtime: {
                nodeVersion: raw.runtime.nodeVersion,
                abi: "migration-validation-1",
            },
            domainContractHashes: domainContractHashes.value,
            entityValidatorNames: entityValidatorNames.value,
        },
    };
}

export function validationArtifactEvidenceHash(info: ValidationArtifactInfo): string {
    const decoded = decodeValidationArtifact(info);
    if (!decoded.ok) throw new TypeError("validation artifact is invalid");
    const json = toJsonValue(decoded.value);
    if (!json.ok) throw new TypeError("validation artifact is not strict JSON");
    return canonicalJsonSha256(json.value);
}

function isValidationModule(value: unknown): value is ValidationModule {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<ValidationModule>;
    return candidate.abi === "migration-validation-1"
        && typeof candidate.snapshotHash === "string"
        && typeof candidate.validatePorts === "function"
        && typeof candidate.validateEntityRow === "function";
}

export async function loadValidationModule(
    info: ValidationArtifactInfo,
    host: ValidationArtifactHost,
): Promise<ValidationResult<ValidationModule>> {
    const decoded = decodeValidationArtifact(info);
    if (!decoded.ok) return decoded;
    const artifact = decoded.value;

    if (host.nodeVersion !== artifact.runtime.nodeVersion) {
        return invalid("validation runtime mismatch", {
            expected: artifact.runtime.nodeVersion,
            actual: host.nodeVersion,
        });
    }

    let bytes: Uint8Array;
    try {
        bytes = await host.readEntry(artifact.entry);
    } catch (error) {
        return invalid("validation entry read failed", {
            path: artifact.entry.path,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.entry.byteLength || actualHash !== artifact.entry.contentHash) {
        return invalid("validation entry checksum mismatch", {
            path: artifact.entry.path,
            expectedHash: artifact.entry.contentHash,
            actualHash,
            expectedBytes: String(artifact.entry.byteLength),
            actualBytes: String(bytes.byteLength),
        });
    }

    let imported: unknown;
    try {
        imported = await host.importModule(artifact.entry, artifact.entry.contentHash);
    } catch (error) {
        return invalid("validation module load failed", {
            path: artifact.entry.path,
            contentHash: artifact.entry.contentHash,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    if (!isValidationModule(imported)) return invalid("invalid validation module exports");
    if (imported.abi !== artifact.runtime.abi) return invalid("validation module ABI mismatch");
    if (imported.snapshotHash !== artifact.snapshotHash) {
        return invalid("validation module snapshot mismatch", {
            expected: artifact.snapshotHash,
            actual: imported.snapshotHash,
        });
    }
    return {ok: true, value: imported};
}

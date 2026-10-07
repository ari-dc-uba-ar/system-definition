import {
    isPlainObject,
    isSha256,
    type FileInfo,
    type Problem,
    type PublishedMigrationInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {
    sha256Hex,
    type ArtifactProblem,
    type ArtifactResult,
} from "./artifact";
import type {CompiledAuthoringInfo, QueryResourceInfo} from "./authoring";
import type {
    AuthoringCheckpointExecution,
    MigrationExecutionContext,
} from "./execute-migration";
import type {QueryRefInfo, SnapshotSide} from "./migration-authoring";
import {
    loadVerifiedMigrationAuthoring,
    type MigrationPlanArtifactContext,
} from "./migration-plan";
import {
    decodeValidationArtifact,
    type ValidationArtifactHost,
    type ValidationArtifactInfo,
} from "./validation-artifact";

const decoder = new TextDecoder("utf-8", {fatal: true});

type SnapshotBinding = {
    snapshot: SystemSnapshotInfo;
    snapshotHash: string;
};

export interface MigrationExecutionArtifactContext extends MigrationPlanArtifactContext {
    readonly snapshots: Readonly<Record<SnapshotSide, SnapshotBinding>>;
    readonly nodeVersion: string;
    importValidationModule(entry: FileInfo, cacheIdentity: string): Promise<unknown>;
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

function validationFailure<T>(problems: readonly Problem[]): ArtifactResult<T> {
    return {
        ok: false,
        problems: problems.map(one => ({...one, message: one.messageKey})),
    };
}

function isFileInfo(value: unknown): value is FileInfo {
    if (!isPlainObject(value)) return false;
    const candidate = value as Partial<FileInfo>;
    return typeof candidate.path === "string"
        && candidate.path.length > 0
        && typeof candidate.contentHash === "string"
        && isSha256(candidate.contentHash)
        && typeof candidate.byteLength === "number"
        && Number.isSafeInteger(candidate.byteLength)
        && candidate.byteLength >= 0;
}

function queryFile(
    name: string,
    value: QueryResourceInfo,
): ArtifactResult<FileInfo> {
    if (name.length === 0
        || value === null
        || typeof value !== "object"
        || value.kind !== "query"
        || !isFileInfo(value.file)) {
        return failure("migration.invalidReference", {
            name,
            reason: "invalid authored query resource metadata",
        });
    }
    return {ok: true, value: value.file};
}

async function resolveQueries(
    migration: PublishedMigrationInfo,
    authoring: CompiledAuthoringInfo,
    runtime: MigrationExecutionArtifactContext,
): Promise<ArtifactResult<AuthoringCheckpointExecution["queryResources"]>> {
    const resolved: Record<string, {ref: QueryRefInfo; text: string}> = Object.create(null) as Record<string, {ref: QueryRefInfo; text: string}>;
    for (const name of Object.keys(authoring.queryResources).sort()) {
        const metadata = queryFile(name, authoring.queryResources[name]);
        if (!metadata.ok) return metadata;

        const bytes = await runtime.readMigrationFile(migration, metadata.value);
        if (!bytes.ok) return bytes;
        const actualHash = sha256Hex(bytes.value);
        if (bytes.value.byteLength !== metadata.value.byteLength || actualHash !== metadata.value.contentHash) {
            return failure("migration.checksumMismatch", {
                name,
                path: metadata.value.path,
                expectedHash: metadata.value.contentHash,
                actualHash,
                expectedBytes: String(metadata.value.byteLength),
                actualBytes: String(bytes.value.byteLength),
            });
        }

        let text: string;
        try {
            text = decoder.decode(bytes.value);
        } catch {
            return failure("migration.unsupportedFormat", {
                name,
                path: metadata.value.path,
                reason: "query artifact is not valid UTF-8",
            });
        }
        if (text.startsWith("\uFEFF")) {
            return failure("migration.unsupportedFormat", {
                name,
                path: metadata.value.path,
                reason: "UTF-8 BOM is not allowed",
            });
        }

        resolved[name] = {
            ref: {name, kind: "query", contentHash: metadata.value.contentHash},
            text,
        };
    }
    return {ok: true, value: resolved};
}

function resolveSnapshots(
    authoring: CompiledAuthoringInfo,
    runtime: MigrationExecutionArtifactContext,
): ArtifactResult<AuthoringCheckpointExecution["snapshots"]> {
    const expected = {
        from: authoring.base.fromSnapshotHash,
        to: authoring.base.toSnapshotHash,
    } as const;
    for (const side of ["from", "to"] as const) {
        const actual = runtime.snapshots[side];
        if (actual === undefined
            || typeof actual.snapshotHash !== "string"
            || actual.snapshotHash !== expected[side]) {
            return failure("migration.checksumMismatch", {
                side,
                expectedHash: expected[side],
                actualHash: actual?.snapshotHash ?? "missing",
                reason: "runtime snapshot does not match immutable authoring",
            });
        }
    }
    return {ok: true, value: runtime.snapshots};
}

function resolveValidationArtifacts(
    authoring: CompiledAuthoringInfo,
): ArtifactResult<readonly ValidationArtifactInfo[]> {
    const artifacts: ValidationArtifactInfo[] = [];
    for (const raw of authoring.validationArtifacts) {
        const decoded = decodeValidationArtifact(raw);
        if (!decoded.ok) return validationFailure(decoded.problems);
        const expectedHash = decoded.value.side === "from"
            ? authoring.base.fromSnapshotHash
            : authoring.base.toSnapshotHash;
        if (decoded.value.snapshotHash !== expectedHash) {
            return failure("migration.validationArtifactInvalid", {
                side: decoded.value.side,
                expectedHash,
                actualHash: decoded.value.snapshotHash,
                reason: "validation artifact snapshot is not the authored snapshot",
            });
        }
        artifacts.push(decoded.value);
    }
    return {ok: true, value: artifacts};
}

function validationHost(
    migration: PublishedMigrationInfo,
    runtime: MigrationExecutionArtifactContext,
): ValidationArtifactHost {
    return {
        nodeVersion: runtime.nodeVersion,
        async readEntry(entry: FileInfo): Promise<Uint8Array> {
            const loaded = await runtime.readMigrationFile(migration, entry);
            if (!loaded.ok) {
                const first = loaded.problems[0];
                throw new Error(first?.messageKey ?? "migration.invalidReference");
            }
            return loaded.value;
        },
        importModule(entry: FileInfo, cacheIdentity: string): Promise<unknown> {
            return runtime.importValidationModule(entry, cacheIdentity);
        },
    };
}

/**
 * Hydrate one immutable published migration into the existing transactional
 * runner context. No caller-provided authoring/query/validator bytes are
 * trusted: the migration manifest and authoring file are re-verified first,
 * then every query and historical validation binding is materialized by hash.
 */
export async function resolveMigrationExecutionContext(
    migration: PublishedMigrationInfo,
    base: Omit<MigrationExecutionContext, "authoring">,
    runtime: MigrationExecutionArtifactContext,
): Promise<ArtifactResult<MigrationExecutionContext>> {
    const verified = await loadVerifiedMigrationAuthoring(migration, runtime);
    if (!verified.ok) return verified;

    const snapshots = resolveSnapshots(verified.value.authoring, runtime);
    if (!snapshots.ok) return snapshots;
    const queries = await resolveQueries(migration, verified.value.authoring, runtime);
    if (!queries.ok) return queries;
    const validationArtifacts = resolveValidationArtifacts(verified.value.authoring);
    if (!validationArtifacts.ok) return validationArtifacts;

    const authoring: AuthoringCheckpointExecution = {
        checkpoints: verified.value.authoring.checkpoints as AuthoringCheckpointExecution["checkpoints"],
        queryResources: queries.value,
        validationArtifacts: validationArtifacts.value,
        validationHost: validationHost(migration, runtime),
        snapshots: snapshots.value,
    };
    return {ok: true, value: {...base, authoring}};
}

import {
    compareUtf16,
    type FileInfo,
    type PublishedMigrationInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {
    sha256Hex,
    type ArtifactProblem,
    type ArtifactResult,
} from "./artifact";
import type {CompiledAuthoringInfo} from "./authoring";
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
    type ValidationArtifactHost,
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
        severity: "blocking",
        details,
    };
    return {ok: false, problems: [one]};
}

async function resolveQueries(
    migration: PublishedMigrationInfo,
    authoring: CompiledAuthoringInfo,
    runtime: MigrationExecutionArtifactContext,
): Promise<ArtifactResult<AuthoringCheckpointExecution["queryResources"]>> {
    const resolved: Record<string, {ref: QueryRefInfo; text: string}> = Object.create(null) as Record<string, {ref: QueryRefInfo; text: string}>;
    for (const [name, {file: metadata}] of Object.entries(authoring.queryResources).sort(([left], [right]) => compareUtf16(left, right))) {

        const bytes = await runtime.readMigrationFile(migration, metadata);
        if (!bytes.ok) return bytes;
        const actualHash = sha256Hex(bytes.value);
        if (bytes.value.byteLength !== metadata.byteLength || actualHash !== metadata.contentHash) {
            return failure("migration.checksumMismatch", {
                name,
                path: metadata.path,
                expectedHash: metadata.contentHash,
                actualHash,
                expectedBytes: String(metadata.byteLength),
                actualBytes: String(bytes.value.byteLength),
            });
        }

        let text: string;
        try {
            text = decoder.decode(bytes.value);
        } catch {
            return failure("migration.unsupportedFormat", {
                name,
                path: metadata.path,
                reason: "query artifact is not valid UTF-8",
            });
        }
        if (text.startsWith("\uFEFF")) {
            return failure("migration.unsupportedFormat", {
                name,
                path: metadata.path,
                reason: "UTF-8 BOM is not allowed",
            });
        }

        resolved[name] = {
            ref: {name, kind: "query", contentHash: metadata.contentHash},
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
    for (const artifact of authoring.validationArtifacts) {
        if (artifact.snapshotHash !== expected[artifact.side]) return failure("migration.validationArtifactInvalid", {
            side: artifact.side, expectedHash: expected[artifact.side], actualHash: artifact.snapshotHash,
            reason: "validation artifact snapshot is not the authored snapshot",
        });
    }
    return {ok: true, value: runtime.snapshots};
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

    const authoring: AuthoringCheckpointExecution = {
        checkpoints: verified.value.authoring.checkpoints,
        queryResources: queries.value,
        validationArtifacts: verified.value.authoring.validationArtifacts,
        validationHost: validationHost(migration, runtime),
        snapshots: snapshots.value,
    };
    return {ok: true, value: {...base, authoring}};
}

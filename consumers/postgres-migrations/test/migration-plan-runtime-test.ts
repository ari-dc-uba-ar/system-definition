import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    canonicalJson,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type MigrationInfo,
    type PublishedMigrationInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {
    computeMigrationHash,
    type ArtifactResult,
    type MigrationManifestInfo,
} from "../src/artifact";
import type {CompiledAuthoringInfo} from "../src/authoring";
import type {MigrationExecutionContext} from "../src/execute-migration";
import {
    resolveMigrationExecutionContext,
    type MigrationExecutionArtifactContext,
} from "../src/migration-plan-runtime";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);
const encoder = new TextEncoder();

const from = {systemId: "demo", releaseId: "A", releaseHash: H1} as const;
const to = {systemId: "demo", releaseId: "B", releaseHash: H2} as const;

function migration(): MigrationInfo {
    return {id: "A-B", from, to, description: "A to B", before: [], steps: [], after: []};
}

function bytesOf(value: unknown): Uint8Array {
    const json = toJsonValue(value);
    if (!json.ok) throw new Error("fixture is not strict JSON");
    return encoder.encode(canonicalJson(json.value));
}

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function file(path: string, bytes: Uint8Array): FileInfo {
    return {path, contentHash: sha256(bytes), byteLength: bytes.byteLength};
}

function authoring(queryFile: FileInfo): CompiledAuthoringInfo {
    return {
        formatVersion: 1,
        draftHash: H3,
        base: {
            from,
            to,
            fromSnapshotHash: H1,
            toSnapshotHash: H2,
            fromPersistenceHash: H3,
            toPersistenceHash: H4,
        },
        migration: migration(),
        operations: [],
        decisions: [],
        checkpoints: [],
        queryResources: {
            people_after: {kind: "query", file: queryFile},
        },
        validationArtifacts: [],
    };
}

function manifest(authoringBytes: Uint8Array): MigrationManifestInfo {
    const value: MigrationManifestInfo = {
        formatVersion: 1,
        migration: migration(),
        authoring: file("authoring.json", authoringBytes),
        migrationHash: "0".repeat(64),
    };
    value.migrationHash = computeMigrationHash(value);
    return value;
}

function published(value: MigrationManifestInfo): PublishedMigrationInfo {
    return {migration: value.migration, migrationHash: value.migrationHash};
}

function ok<T>(value: T): ArtifactResult<T> {
    return {ok: true, value};
}

const snapshot = {formatVersion: 1} as unknown as SystemSnapshotInfo;

function baseContext(): Omit<MigrationExecutionContext, "authoring"> {
    return {
        journal: {schema: "sd_journal"},
        scope: {systemId: "demo", schemas: ["app"]},
        resources: {},
        from: {expectedSchema: {tables: [], objects: []}, inspection: {schemas: ["app"]}, managedData: [], invariantChecks: []} as never,
        to: {expectedSchema: {tables: [], objects: []}, inspection: {schemas: ["app"]}, managedData: [], invariantChecks: []} as never,
        options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
        now: () => "2026-10-01T18:00:00.000Z",
    };
}

class MemoryRuntime implements MigrationExecutionArtifactContext {
    readonly files = new Map<string, Uint8Array>();
    manifestValue!: JsonValue;
    snapshots = {
        from: {snapshot, snapshotHash: H1},
        to: {snapshot, snapshotHash: H2},
    } as const;
    readonly nodeVersion = process.version;

    async loadMigrationManifest(_migration: PublishedMigrationInfo): Promise<ArtifactResult<JsonValue>> {
        return ok(this.manifestValue);
    }

    async readMigrationFile(one: PublishedMigrationInfo, entry: FileInfo): Promise<ArtifactResult<Uint8Array>> {
        const found = this.files.get(one.migrationHash + ":" + entry.path);
        return found === undefined
            ? {ok: false, problems: [{field: null, messageKey: "migration.invalidReference", message: "migration.invalidReference", severity: "blocking", details: {path: entry.path}}]}
            : ok(found);
    }

    async importValidationModule(_entry: FileInfo, _cacheIdentity: string): Promise<unknown> {
        throw new Error("not used by these fixtures");
    }
}

function install(runtime: MemoryRuntime, queryText = "SELECT id, email FROM app.people ORDER BY id"): PublishedMigrationInfo {
    const queryBytes = encoder.encode(queryText);
    const authored = authoring(file("queries/people-after.sql", queryBytes));
    const authoringBytes = bytesOf(authored);
    const manifestValue = manifest(authoringBytes);
    const one = published(manifestValue);
    const json = toJsonValue(manifestValue);
    if (!json.ok) throw new Error("manifest fixture is not strict JSON");
    runtime.manifestValue = json.value;
    runtime.files.set(one.migrationHash + ":authoring.json", authoringBytes);
    runtime.files.set(one.migrationHash + ":queries/people-after.sql", queryBytes);
    return one;
}

function firstKey(result: {ok: boolean; problems?: readonly {messageKey: string}[]}): string | undefined {
    return result.ok ? undefined : result.problems?.[0]?.messageKey;
}

describe("T22 plan-bound runner artifact resolution", () => {
    it("hydrates exact query bytes into the runner authoring context", async () => {
        const runtime = new MemoryRuntime();
        const one = install(runtime);
        const result = await resolveMigrationExecutionContext(one, baseContext(), runtime);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.value.authoring?.queryResources.people_after?.text, "SELECT id, email FROM app.people ORDER BY id");
        assert.equal(result.value.authoring?.queryResources.people_after?.ref.kind, "query");
        assert.equal(result.value.authoring?.queryResources.people_after?.ref.name, "people_after");
        assert.equal(result.value.authoring?.queryResources.people_after?.ref.contentHash, sha256(encoder.encode("SELECT id, email FROM app.people ORDER BY id")));
        assert.equal(result.value.authoring?.snapshots.from.snapshotHash, H1);
        assert.equal(result.value.authoring?.snapshots.to.snapshotHash, H2);
    });

    it("rejects missing or changed query bytes before returning an execution context", async () => {
        const missing = new MemoryRuntime();
        const oneMissing = install(missing);
        missing.files.delete(oneMissing.migrationHash + ":queries/people-after.sql");
        assert.equal(firstKey(await resolveMigrationExecutionContext(oneMissing, baseContext(), missing)), "migration.invalidReference");

        const changed = new MemoryRuntime();
        const oneChanged = install(changed);
        changed.files.set(oneChanged.migrationHash + ":queries/people-after.sql", encoder.encode("SELECT 1"));
        assert.equal(firstKey(await resolveMigrationExecutionContext(oneChanged, baseContext(), changed)), "migration.checksumMismatch");
    });

    it("rejects snapshots that do not match the hashes bound by authoring", async () => {
        const runtime = new MemoryRuntime();
        const one = install(runtime);
        runtime.snapshots = {
            from: {snapshot, snapshotHash: "9".repeat(64)},
            to: {snapshot, snapshotHash: H2},
        } as const;
        assert.equal(firstKey(await resolveMigrationExecutionContext(one, baseContext(), runtime)), "migration.checksumMismatch");
    });

    it("rejects malformed validation artifact metadata before the runner can execute", async () => {
        const runtime = new MemoryRuntime();
        const queryBytes = encoder.encode("SELECT id FROM app.people");
        const authored = authoring(file("queries/people-after.sql", queryBytes));
        authored.validationArtifacts = [{formatVersion: 99}] as unknown as CompiledAuthoringInfo["validationArtifacts"];
        const authoringBytes = bytesOf(authored);
        const manifestValue = manifest(authoringBytes);
        const one = published(manifestValue);
        const json = toJsonValue(manifestValue);
        if (!json.ok) throw new Error("manifest fixture is not strict JSON");
        runtime.manifestValue = json.value;
        runtime.files.set(one.migrationHash + ":authoring.json", authoringBytes);
        runtime.files.set(one.migrationHash + ":queries/people-after.sql", queryBytes);
        assert.equal(firstKey(await resolveMigrationExecutionContext(one, baseContext(), runtime)), "migration.validationArtifactInvalid");
    });

    it("re-verifies the immutable migration identity instead of trusting a caller-supplied context", async () => {
        const runtime = new MemoryRuntime();
        const one = install(runtime);
        const tampered = {...one, migrationHash: "f".repeat(64)};
        assert.equal(firstKey(await resolveMigrationExecutionContext(tampered, baseContext(), runtime)), "migration.checksumMismatch");
    });
});

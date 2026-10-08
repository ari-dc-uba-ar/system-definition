import {canonicalJson, toJsonValue, type FileInfo, type SystemSnapshotInfo} from "system-definition";
import {computeMigrationHash, sha256Hex, type MigrationManifestInfo, type ArtifactResult} from "./artifact";
import type {CompiledAuthoringInfo} from "./authoring-contract";
import type {AuthoringFiles} from "./authoring-files";
import type {MigrationExecutionArtifactContext} from "./migration-plan-runtime";

/** Authoring replay uses exactly the manifest loader and hash checks used by published execution. */
export function compiledArtifact(
    compiled: CompiledAuthoringInfo, files: AuthoringFiles,
    snapshots: {from: SystemSnapshotInfo; to: SystemSnapshotInfo},
) {
    const converted = toJsonValue(compiled);
    if (!converted.ok) throw new Error("Compiled authoring is not strict JSON");
    const bytes = new TextEncoder().encode(canonicalJson(converted.value));
    const authoring = {path: "authoring.json", contentHash: sha256Hex(bytes), byteLength: bytes.length};
    files.files.set(authoring.path, bytes);
    const manifest: MigrationManifestInfo = {formatVersion: 1, migration: compiled.migration, authoring, migrationHash: "0".repeat(64)};
    manifest.migrationHash = computeMigrationHash(manifest);
    const published = {migration: manifest.migration, migrationHash: manifest.migrationHash};
    const json = toJsonValue(manifest);
    if (!json.ok) throw new Error("Migration manifest is not strict JSON");
    const manifestValue = json.value;
    async function read(file: FileInfo): Promise<ArtifactResult<Uint8Array>> {
        const value = files.files.get(file.path);
        if (value === undefined || value.length !== file.byteLength || sha256Hex(value) !== file.contentHash) {
            return {ok: false, problems: [{field: null, messageKey: "migration.checksumMismatch", message: "migration.checksumMismatch", severity: "blocking", details: {path: file.path}}]};
        }
        return {ok: true, value};
    }
    const runtime: MigrationExecutionArtifactContext = {
        snapshots: {
            from: {snapshot: snapshots.from, snapshotHash: compiled.base.fromSnapshotHash},
            to: {snapshot: snapshots.to, snapshotHash: compiled.base.toSnapshotHash},
        },
        nodeVersion: process.version,
        async loadMigrationManifest() { return {ok: true, value: manifestValue}; },
        async readMigrationFile(_migration, file) { return read(file); },
        async importValidationModule(file, cacheIdentity) {
            const result = await read(file);
            if (!result.ok) throw new Error(JSON.stringify(result.problems));
            return import(`data:text/javascript;base64,${Buffer.from(result.value).toString("base64")}#${cacheIdentity}`);
        },
    };
    return {published, manifest, runtime};
}

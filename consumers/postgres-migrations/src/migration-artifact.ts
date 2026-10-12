import {problem, sameContentRef, type PublishedMigrationInfo, type ValidationResult} from "system-definition";
import {canonicalBytes, computeMigrationHash, decodeMigrationManifest, sha256Hex, type ArtifactResult, type MigrationManifestInfo} from "./artifact";
import type {CompiledAuthoringInfo} from "./authoring-contract";
import type {AuthoringFiles} from "./authoring-files";
import {publishArtifactDirectory} from "./artifact-files";

/** The same canonical authoring bytes bind replay and saved migrations. */
export function createMigrationManifest(compiled: CompiledAuthoringInfo, files: AuthoringFiles): ArtifactResult<MigrationManifestInfo> {
    const encoded = canonicalBytes(compiled);
    if (!encoded.ok) return encoded;
    const authoring = {path: "authoring.json", contentHash: sha256Hex(encoded.value.bytes), byteLength: encoded.value.bytes.length};
    const manifest: MigrationManifestInfo = {formatVersion: 1, migration: compiled.migration, authoring, migrationHash: "0".repeat(64)};
    manifest.migrationHash = computeMigrationHash(manifest);
    const json = canonicalBytes(manifest);
    if (!json.ok) return json;
    const checked = decodeMigrationManifest(json.value.value);
    if (!checked.ok) return checked;
    files.files.set(authoring.path, encoded.value.bytes);
    return checked;
}

/** Save one complete immutable directory; no database reads, replay or application. */
export async function saveMigrationArtifact(destination: string, compiled: CompiledAuthoringInfo, files: AuthoringFiles): Promise<ValidationResult<PublishedMigrationInfo>> {
    const refs = [...compiled.migration.before, ...compiled.migration.steps.map(step => step.run), ...compiled.migration.after,
        ...compiled.checkpoints.flatMap(checkpoint => checkpoint.checks)];
    for (const ref of refs) {
        const resource = files.resources.get(ref.name);
        if (resource === undefined || !sameContentRef(resource.ref, ref)) return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {name: ref.name, reason: "Missing migration resource"})]};
    }
    for (const resource of files.resources.values()) {
        const bytes = files.files.get(`generated/${resource.ref.contentHash}.sql`);
        if (bytes === undefined || sha256Hex(bytes) !== resource.ref.contentHash || sha256Hex(new TextEncoder().encode(resource.text)) !== resource.ref.contentHash) return {ok: false, problems: [problem(null, "migration.checksumMismatch", "blocking", {name: resource.ref.name})]};
    }
    const manifest = createMigrationManifest(compiled, files);
    if (!manifest.ok) return manifest;
    const encoded = canonicalBytes(manifest.value), resources = canonicalBytes([...files.resources.values()]);
    if (!encoded.ok) return encoded;
    if (!resources.ok) return resources;
    const saved = new Map(files.files);
    saved.set("migration.json", encoded.value.bytes);
    saved.set("resources.json", resources.value.bytes);
    await publishArtifactDirectory(destination, saved);
    return {ok: true, value: {migration: manifest.value.migration, migrationHash: manifest.value.migrationHash}};
}

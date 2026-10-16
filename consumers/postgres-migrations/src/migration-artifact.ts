import {problem, sameContentRef, type FileInfo, type JsonValue, type PublishedMigrationInfo, type ValidationResult} from "system-definition";
import {canonicalBytes, computeMigrationHash, decodeMigrationManifest, readArtifactJson, sha256Hex, type ArtifactResult, type MigrationManifestInfo} from "./artifact";
import type {CompiledAuthoringInfo} from "./authoring-contract";
import type {AuthoringFiles} from "./authoring-files";
import {isSafeArtifactPath, openArtifactDirectory, publishArtifactDirectory} from "./artifact-files";

export async function loadMigrationManifest(directory: string): Promise<ArtifactResult<MigrationManifestInfo>> {
    const reader = await openArtifactDirectory(directory);
    if (!reader.ok) return reader;
    const loaded = await readArtifactJson(reader.value, "migration.json", false);
    if (!loaded.ok) return loaded;
    return decodeMigrationManifest(loaded.value);
}

/** The same canonical authoring bytes bind replay and saved migrations. */
export function createMigrationManifest(compiled: CompiledAuthoringInfo, files: AuthoringFiles, script?: FileInfo): ArtifactResult<MigrationManifestInfo> {
    const encoded = canonicalBytes(compiled);
    if (!encoded.ok) return encoded;
    const registry = canonicalBytes([...files.resources.values()]);
    if (!registry.ok) return registry;
    const authoring = {path: "authoring.json", contentHash: sha256Hex(encoded.value.bytes), byteLength: encoded.value.bytes.length};
    const resources = {path: "resources.json", contentHash: sha256Hex(registry.value.bytes), byteLength: registry.value.bytes.length};
    const manifest: MigrationManifestInfo = {formatVersion: 1, migration: compiled.migration, authoring, resources, ...(script === undefined ? {} : {script}), migrationHash: "0".repeat(64)};
    manifest.migrationHash = computeMigrationHash(manifest);
    const json = canonicalBytes(manifest);
    if (!json.ok) return json;
    const checked = decodeMigrationManifest(json.value.value);
    if (!checked.ok) return checked;
    files.files.set(authoring.path, encoded.value.bytes);
    files.files.set(resources.path, registry.value.bytes);
    return checked;
}

/** Render the saved resources in execution order. Checks still require the migration runner. */
export function migrationSql(compiled: CompiledAuthoringInfo, files: AuthoringFiles, initialReview?: string): string {
    const sections: string[] = [];
    const resource = (name: string) => {
        const item = files.resources.get(name);
        if (item === undefined) throw new Error("Missing migration resource: " + name);
        sections.push(item.text.trimEnd());
    };
    if (compiled.initial !== undefined || initialReview !== undefined) {
        sections.push("BEGIN;");
        if (compiled.initial !== undefined) resource(compiled.initial.name);
        else if (initialReview !== undefined) sections.push(initialReview.trimEnd());
        sections.push("COMMIT;");
    }
    sections.push("BEGIN;");
    for (const ref of compiled.migration.before) resource(ref.name);
    for (const step of compiled.migration.steps) {
        resource(step.run.name);
        for (const checkpoint of compiled.checkpoints.filter(one => one.afterStep === step.id)) {
            for (const ref of checkpoint.checks) resource(ref.name);
        }
    }
    for (const ref of compiled.migration.after) resource(ref.name);
    sections.push("COMMIT;");
    return sections.join("\n\n") + "\n";
}

/** Compact storage preserves the exact virtual file bytes expected by existing readers. */
export function compactMigrationFiles(files: ReadonlyMap<string, Uint8Array>, sqlName: string, sql: string): ReadonlyMap<string, Uint8Array> {
    const metadata: Record<string, JsonValue> = Object.create(null);
    const saved = new Map<string, Uint8Array>([[sqlName, new TextEncoder().encode(sql)]]);
    const decoder = new TextDecoder("utf-8", {fatal: true});
    for (const [path, bytes] of files) {
        if (/^generated\/[a-f0-9]{64}\.sql$/.test(path)) continue; // SQL bytes are already in the resource registry.
        if (path === sqlName) saved.set(path, bytes);
        else {
            const text = decoder.decode(bytes);
            const parsed = path.endsWith(".json") ? canonicalBytes(JSON.parse(text)) : undefined;
            metadata[path] = parsed?.ok && sha256Hex(parsed.value.bytes) === sha256Hex(bytes) ? parsed.value.value : text;
        }
    }
    metadata["script.json"] = {path: sqlName, contentHash: sha256Hex(saved.get(sqlName)!), byteLength: saved.get(sqlName)!.length};
    saved.set("metadata.json", new TextEncoder().encode(JSON.stringify(metadata, null, 2) + "\n"));
    return saved;
}

/** Save one complete immutable directory; no database reads, replay or application. */
export async function saveMigrationArtifact(destination: string, compiled: CompiledAuthoringInfo, files: AuthoringFiles, sqlName = "migration.sql"): Promise<ValidationResult<PublishedMigrationInfo>> {
    if (!isSafeArtifactPath(sqlName) || sqlName.includes("/") || !sqlName.endsWith(".sql")) return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {reason: "Expected one SQL filename"})]};
    const refs = [...(compiled.initial === undefined ? [] : [compiled.initial]), ...compiled.migration.before, ...compiled.migration.steps.map(step => step.run), ...compiled.migration.after,
        ...compiled.checkpoints.flatMap(checkpoint => checkpoint.checks)];
    for (const ref of refs) {
        const resource = files.resources.get(ref.name);
        if (resource === undefined || !sameContentRef(resource.ref, ref)) return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {name: ref.name, reason: "Missing migration resource"})]};
    }
    for (const resource of files.resources.values()) {
        const bytes = files.files.get(`generated/${resource.ref.contentHash}.sql`);
        if (bytes === undefined || sha256Hex(bytes) !== resource.ref.contentHash || sha256Hex(new TextEncoder().encode(resource.text)) !== resource.ref.contentHash) return {ok: false, problems: [problem(null, "migration.checksumMismatch", "blocking", {name: resource.ref.name})]};
    }
    const sql = migrationSql(compiled, files);
    const bytes = new TextEncoder().encode(sql), script = {path: sqlName, contentHash: sha256Hex(bytes), byteLength: bytes.length};
    const manifest = createMigrationManifest(compiled, files, script);
    if (!manifest.ok) return manifest;
    const encoded = canonicalBytes(manifest.value);
    if (!encoded.ok) return encoded;
    const saved = new Map(files.files);
    saved.set("migration.json", encoded.value.bytes);
    await publishArtifactDirectory(destination, compactMigrationFiles(saved, sqlName, sql));
    return {ok: true, value: {migration: manifest.value.migration, migrationHash: manifest.value.migrationHash}};
}

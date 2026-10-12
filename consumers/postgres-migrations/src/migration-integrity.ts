import {decodeContentRefInfo, decodeFileResourceInfo, isPlainObject, problem, type PublishedMigrationInfo, type ValidationResult} from "system-definition";
import {parseJsonBytes, readArtifactJson, sha256Hex} from "./artifact";
import {openArtifactDirectory} from "./artifact-files";
import {loadVerifiedMigrationAuthoring, type VerifiedMigrationAuthoring} from "./migration-plan";
import {decodeValidationArtifact} from "./validation-artifact";

function invalid(path: string, reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {path, reason})]};
}

/** Verify bound file bytes only. Never execute SQL, import validators or inspect a database. */
export async function verifyMigrationFiles(directory: string, expected: PublishedMigrationInfo): Promise<ValidationResult<VerifiedMigrationAuthoring>> {
    const opened = await openArtifactDirectory(directory);
    if (!opened.ok) return opened;
    const reader = opened.value;
    const verified = await loadVerifiedMigrationAuthoring(expected, {
        async loadMigrationManifest() {return readArtifactJson(reader, "migration.json", false);},
        async readMigrationFile(_migration, file) {return reader.readVerified(file);},
    });
    if (!verified.ok) return verified;
    const {manifest, authoring} = verified.value;
    const refs: unknown[] = [...authoring.migration.before, ...authoring.migration.steps.map(step => step.run), ...authoring.migration.after];
    for (const checkpoint of authoring.checkpoints) {
        if (!isPlainObject(checkpoint) || !Array.isArray(checkpoint.checks)) return invalid("checkpoints", "Malformed checkpoint checks");
        refs.push(...checkpoint.checks);
    }
    const registry = manifest.resources ? await reader.readVerified(manifest.resources) : await reader.read("resources.json");
    if (!registry.ok) return registry;
    const parsed = parseJsonBytes(registry.value, "resources.json", manifest.resources !== undefined);
    if (!parsed.ok) return parsed;
    if (!Array.isArray(parsed.value)) return invalid("resources.json", "Expected a resource registry");
    for (const resource of parsed.value) {
        if (!isPlainObject(resource) || !isPlainObject(resource.ref) || typeof resource.text !== "string") return invalid("resources.json", "Malformed resource");
        if (sha256Hex(new TextEncoder().encode(resource.text)) !== resource.ref.contentHash) return {ok: false, problems: [problem(null, "migration.checksumMismatch", "blocking", {path: "resources.json"})]};
        refs.push(resource.ref);
    }
    for (const [index, raw] of refs.entries()) {
        if (!isPlainObject(raw) || typeof raw.kind !== "string" || !["sql", "check", "query"].includes(raw.kind)) return invalid(`resources[${index}]`, "Unknown resource kind");
        const ref = decodeContentRefInfo(raw, `resources[${index}]`, raw.kind, invalid);
        if (!ref.ok) return ref;
        const path = `generated/${ref.value.contentHash}.sql`;
        const bytes = await reader.read(path);
        if (!bytes.ok) return bytes;
        if (sha256Hex(bytes.value) !== ref.value.contentHash) return {ok: false, problems: [problem(null, "migration.checksumMismatch", "blocking", {path})]};
    }
    for (const [name, raw] of Object.entries(authoring.queryResources)) {
        const query = decodeFileResourceInfo(raw, name, "query", invalid);
        if (!query.ok) return query;
        const bytes = await reader.readVerified(query.value.file);
        if (!bytes.ok) return bytes;
    }
    for (const raw of authoring.validationArtifacts) {
        const artifact = decodeValidationArtifact(raw);
        if (!artifact.ok) return artifact;
        const bytes = await reader.readVerified(artifact.value.entry);
        if (!bytes.ok) return bytes;
    }
    return verified;
}

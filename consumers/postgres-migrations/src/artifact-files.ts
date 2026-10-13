import {lstat, mkdir, readFile, realpath, rename, rm, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {canonicalJson, decodeFileInfo, isPlainObject, problem, toJsonValue, type FileInfo, type JsonValue} from "system-definition";
import type {ArtifactResult} from "./artifact";
import {sha256Hex} from "./canonical-hash";

function failure<T>(key: string, details: Readonly<Record<string, string>>): ArtifactResult<T> {
    return {ok: false, problems: [problem(null, key, "blocking", details)]};
}

export function isSafeArtifactPath(path: string): boolean {
    return path.length > 0 && !path.includes("\0") && !path.includes("\\") && !isAbsolute(path)
        && !/^[A-Za-z]:/.test(path) && !path.startsWith("/")
        && path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

export function verifyArtifactPaths(paths: readonly string[]): ArtifactResult<true> {
    const seen = new Map<string, string>();
    for (const path of paths) {
        if (!isSafeArtifactPath(path)) return failure("migration.invalidReference", {path, reason: "unsafe artifact path"});
        const existing = seen.get(path.toLowerCase());
        if (existing !== undefined) return failure("migration.invalidReference", {path, reason: "case-colliding artifact path", existing});
        seen.set(path.toLowerCase(), path);
    }
    return {ok: true, value: true};
}

export async function artifactExists(path: string): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

/** A reader opened against a checked directory. Manifests are read before their
 * references are decoded; payloads are read through the core's byte-addressed FileInfo. */
export interface ArtifactDirectory {
    read(path: string): Promise<ArtifactResult<Uint8Array>>;
    readVerified(file: FileInfo): Promise<ArtifactResult<Uint8Array>>;
}

export async function openArtifactDirectory(directory: string): Promise<ArtifactResult<ArtifactDirectory>> {
    let root: string;
    try {
        const stat = await lstat(directory);
        root = await realpath(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory() || resolve(root) !== resolve(directory)) {
            return failure("migration.invalidReference", {path: directory, reason: "artifact directory must not traverse a symlink"});
        }
    } catch (error) {
        return failure("migration.invalidReference", {path: directory, reason: error instanceof Error ? error.message : String(error)});
    }
    const readPhysical: ArtifactDirectory["read"] = async path => {
        if (!isSafeArtifactPath(path)) return failure("migration.invalidReference", {path, reason: "unsafe artifact path"});
        try {
            let current = root;
            const parts = path.split("/");
            for (const [index, part] of parts.entries()) {
                current = join(current, part);
                const stat = await lstat(current);
                if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
                    return failure("migration.invalidReference", {path, reason: "artifact path must contain real directories and a regular file"});
                }
            }
            const inside = relative(root, current);
            if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) {
                return failure("migration.invalidReference", {path, reason: "artifact path escapes its directory"});
            }
            return {ok: true, value: await readFile(current)};
        } catch (error) {
            return failure("migration.invalidReference", {path, reason: error instanceof Error ? error.message : String(error)});
        }
    };
    let archive: Readonly<Record<string, JsonValue>> | undefined;
    if (await artifactExists(join(root, "metadata.json"))) {
        const metadata = await readPhysical("metadata.json");
        if (!metadata.ok) return metadata;
        try {
            const parsed = toJsonValue(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(metadata.value)));
            if (!parsed.ok) return parsed;
            const value = parsed.value;
            if (!isPlainObject(value) || Object.keys(value).some(path => !isSafeArtifactPath(path))) return failure("migration.unsupportedFormat", {reason: "invalid migration metadata"});
            archive = value as Readonly<Record<string, JsonValue>>;
            const descriptor = archive["script.json"];
            if (descriptor !== undefined) {
                const script = decodeFileInfo(descriptor, "script", (path, reason) => failure("migration.invalidReference", {path, reason}));
                if (!script.ok) return script;
                const bytes = await readPhysical(script.value.path); if (!bytes.ok) return bytes;
                if (bytes.value.length !== script.value.byteLength || sha256Hex(bytes.value) !== script.value.contentHash) return failure("migration.checksumMismatch", {path: script.value.path});
            }
        } catch (error) {return failure("migration.invalidJson", {reason: error instanceof Error ? error.message : String(error)});}
    }
    const read: ArtifactDirectory["read"] = async path => {
        if (!isSafeArtifactPath(path)) return failure("migration.invalidReference", {path, reason: "unsafe artifact path"});
        const stored = archive?.[path];
        if (stored !== undefined && Object.hasOwn(archive!, path)) return {ok: true, value: new TextEncoder().encode(typeof stored === "string" ? stored : canonicalJson(stored))};
        if (archive !== undefined && /^generated\/[a-f0-9]{64}\.sql$/.test(path)) {
            try {
                const source = archive["resources.json"] ?? [];
                const registry: unknown = typeof source === "string" ? JSON.parse(source) : source;
                if (!Array.isArray(registry)) return failure("migration.unsupportedFormat", {reason: "invalid resource registry"});
                const resource: unknown = registry.find((raw: unknown) => isPlainObject(raw) && isPlainObject(raw.ref) && path === `generated/${raw.ref.contentHash}.sql`);
                if (!isPlainObject(resource) || typeof resource.text !== "string") return failure("migration.invalidReference", {path, reason: "missing migration SQL"});
                return {ok: true, value: new TextEncoder().encode(resource.text)};
            } catch (error) {return failure("migration.invalidJson", {path, reason: String(error)});}
        }
        return readPhysical(path);
    };
    return {ok: true, value: {read, async readVerified(file) {
        const loaded = await read(file.path);
        if (!loaded.ok) return loaded;
        return loaded.value.length === file.byteLength && sha256Hex(loaded.value) === file.contentHash
            ? loaded : failure("migration.checksumMismatch", {path: file.path});
    }}};
}

/** Publish exact bytes together. Callers decide whether an existing identity is
 * reusable; this filesystem operation never replaces it or serializes its payloads. */
export async function publishArtifactDirectory(destination: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const paths = verifyArtifactPaths([...files.keys()]);
    if (!paths.ok) throw new Error(JSON.stringify(paths.problems));
    if (await artifactExists(destination)) throw Object.assign(new Error("Published artifact directory already exists"), {code: "EEXIST", path: destination});
    const parent = dirname(resolve(destination));
    await mkdir(parent, {recursive: true});
    const temporary = join(parent, ".artifact-" + randomUUID() + ".tmp");
    await mkdir(temporary);
    try {
        for (const [path, bytes] of files) {
            const target = join(temporary, ...path.split("/"));
            await mkdir(dirname(target), {recursive: true});
            await writeFile(target, bytes, {flag: "wx"});
        }
        await rename(temporary, resolve(destination));
    } finally { await rm(temporary, {recursive: true, force: true}); }
}

import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {completeMigrationCatalog, decodePublishedMigrationInfo, decodeReleaseRefInfo, isPlainObject, problem, sameReleaseRef, type FileInfo, type MigrationCatalogInfo, type PublishedMigrationInfo, type ReleaseRefInfo, type ValidationResult} from "system-definition";
import {canonicalBytes, parseJsonBytes, loadReleaseArtifact, sha256Hex} from "./artifact";
import {isSafeArtifactPath, openArtifactDirectory} from "./artifact-files";
import {decodeSqlSsot, projectSsotSchema, type SqlSsotInfo} from "./sql-mapping";
import type {PgSchemaInfo} from "./pg-schema";
import {verifyMigrationFiles} from "./migration-integrity";

export type MigrationStateInfo = SqlSsotInfo & {releaseId: string; namespace: string; schema: PgSchemaInfo};
export type StoredMigrationCatalog = MigrationCatalogInfo & {baselineDirectory?: string};
export const invalidStore = (reason: string, key = "migration.invalidReference"): ValidationResult<never> => ({ok: false, problems: [problem(null, key, "blocking", {reason})]});

export function jsonBytes(value: unknown): Uint8Array {
    const encoded = canonicalBytes(value);
    if (!encoded.ok) throw new Error(JSON.stringify(encoded.problems));
    return encoded.value.bytes;
}
export function stateReference(state: MigrationStateInfo): ReleaseRefInfo {
    return {systemId: state.ssot.systemId, releaseId: state.releaseId, releaseHash: sha256Hex(jsonBytes(state))};
}
export async function captureMigrationState(system: SqlSsotInfo, namespace: string, releaseId: string): Promise<ValidationResult<MigrationStateInfo>> {
    const schema = projectSsotSchema(system, namespace);
    if (!schema.ok) return schema;
    const {tables: _projection, ...physicalSchema} = schema.value;
    return {ok: true, value: {...system, releaseId, namespace, schema: physicalSchema}};
}
export async function readStateBytes(bytes: Uint8Array): Promise<ValidationResult<MigrationStateInfo>> {
    const parsed = parseJsonBytes(bytes, "state.json");
    if (!parsed.ok) return parsed;
    const raw = parsed.value;
    if (!isPlainObject(raw) || typeof raw.releaseId !== "string" || typeof raw.namespace !== "string" || !isPlainObject(raw.persistence) || !isPlainObject(raw.persistence.representations)) return invalidStore("Malformed saved migration state");
    const system = decodeSqlSsot(raw.ssot, raw.persistence.representations.postgres);
    if (!system.ok) return system;
    const state = await captureMigrationState(system.value, raw.namespace, raw.releaseId);
    if (!state.ok) return state;
    return sha256Hex(jsonBytes(state.value)) === sha256Hex(bytes) ? state : invalidStore("Saved state is not the declared SSOT projection", "migration.checksumMismatch");
}
export async function writeJsonAtomic(file: string, value: unknown, pretty = false): Promise<void> {
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, pretty ? JSON.stringify(value, null, 2) + "\n" : jsonBytes(value), {flag: "wx"});
    await rename(temporary, file);
}
export function migrationDirectory(root: string, migration: PublishedMigrationInfo): string {
    const id = migration.migration.id;
    if (!isSafeArtifactPath(id) || id.includes("/")) throw new Error("Migration id must be one safe directory name");
    return join(root, "entries", id);
}
export async function readStoredCatalog(root: string): Promise<ValidationResult<StoredMigrationCatalog>> {
    const parsed = parseJsonBytes(await readFile(join(root, "catalog.json")), "catalog.json", false);
    if (!parsed.ok) return parsed;
    const raw = parsed.value;
    if (!isPlainObject(raw) || !Array.isArray(raw.releases) || !Array.isArray(raw.migrations) || (raw.baselineDirectory !== undefined && typeof raw.baselineDirectory !== "string")) return invalidStore("Malformed migration catalog");
    const releases: ReleaseRefInfo[] = [], migrations: PublishedMigrationInfo[] = [];
    for (const rawRef of raw.releases) {
        const ref = decodeReleaseRefInfo(rawRef, "catalog.releases", (_path, reason) => invalidStore(reason));
        if (!ref.ok) return ref;
        releases.push(ref.value);
    }
    for (const rawMigration of raw.migrations) {
        const migration = decodePublishedMigrationInfo(rawMigration, "catalog.migrations", (_path, reason) => invalidStore(reason));
        if (!migration.ok) return migration;
        migrations.push(migration.value);
    }
    const catalog = completeMigrationCatalog(releases, migrations);
    if (!catalog.ok) return catalog;
    if (catalog.value.systemId !== raw.systemId) return invalidStore("Catalog system mismatch");
    return {ok: true, value: {...catalog.value, ...(raw.baselineDirectory === undefined ? {} : {baselineDirectory: raw.baselineDirectory})}};
}
export async function initializeMigrationStore(root: string, target: SqlSsotInfo, namespace: string, baselineDirectory?: string): Promise<ValidationResult<StoredMigrationCatalog>> {
    try {return await readStoredCatalog(root);}
    catch (error) {if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;}
    await mkdir(root, {recursive: true});
    let baseline: ReleaseRefInfo;
    if (baselineDirectory !== undefined) {
        const loaded = await loadReleaseArtifact(resolve(baselineDirectory));
        if (!loaded.ok) return loaded;
        baseline = loaded.value.manifest.release;
        if (baseline.systemId !== target.ssot.systemId) return invalidStore("Baseline belongs to another SSOT");
    } else {
        const empty = decodeSqlSsot({...target.ssot, entities: {}}, target.persistence.representations.postgres);
        if (!empty.ok) return empty;
        const state = await captureMigrationState(empty.value, namespace, "empty");
        if (!state.ok) return state;
        baseline = stateReference(state.value);
        await writeFile(join(root, "baseline.json"), jsonBytes(state.value), {flag: "wx"});
    }
    const catalog = completeMigrationCatalog([baseline], []);
    if (!catalog.ok) return catalog;
    const stored = {...catalog.value, ...(baselineDirectory === undefined ? {} : {baselineDirectory: resolve(baselineDirectory)})};
    await writeJsonAtomic(join(root, "catalog.json"), stored, true);
    return {ok: true, value: stored};
}
export async function readCatalogState(root: string, catalog: StoredMigrationCatalog, index: number): Promise<ValidationResult<MigrationStateInfo>> {
    const expected = catalog.releases[index];
    if (expected === undefined) return invalidStore("Unknown catalog state");
    if (index === 0 && catalog.baselineDirectory !== undefined) {
        const loaded = await loadReleaseArtifact(catalog.baselineDirectory);
        if (!loaded.ok) return loaded;
        if (!sameReleaseRef(loaded.value.manifest.release, expected)) return invalidStore("Baseline artifact changed", "migration.checksumMismatch");
        const mapped = decodeSqlSsot(loaded.value.snapshot, loaded.value.persistence.representations.postgres);
        if (!mapped.ok) return mapped;
        return captureMigrationState(mapped.value, loaded.value.createPlan.schema, expected.releaseId);
    }
    let bytes: Uint8Array;
    if (index === 0) bytes = await readFile(join(root, "baseline.json"));
    else {
        const published = catalog.migrations[index - 1];
        const directory = migrationDirectory(root, published);
        const verified = await verifyMigrationFiles(directory, published);
        if (!verified.ok) return verified;
        const file = verified.value.authoring.states?.to;
        if (file === undefined) return invalidStore("Migration does not include its saved target state");
        const reader = await openArtifactDirectory(directory);
        if (!reader.ok) return reader;
        const read = await reader.value.readVerified(file);
        if (!read.ok) return read;
        bytes = read.value;
    }
    const state = await readStateBytes(bytes);
    return state.ok && !sameReleaseRef(stateReference(state.value), expected) ? invalidStore("Recorded state hash changed", "migration.checksumMismatch") : state;
}
export function stateFile(path: string, state: MigrationStateInfo): FileInfo {
    const bytes = jsonBytes(state);
    return {path, contentHash: sha256Hex(bytes), byteLength: bytes.length};
}

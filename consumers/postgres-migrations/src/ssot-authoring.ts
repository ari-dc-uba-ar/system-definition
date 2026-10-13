import {readFile, mkdir, unlink} from "node:fs/promises";
import {dirname, join} from "node:path";
import {completeMigrationCatalog, isPlainObject, sameReleaseRef, type ValidationResult} from "system-definition";
import {parseJsonBytes, sha256Hex} from "./artifact";
import type {DatabaseSettings} from "./database-settings";
import type {SqlSsotInfo} from "./sql-mapping";
import {createMigrationDraft, decodeMigrationDraftInfo} from "./migration-draft";
import {computeDraftRevisionHash} from "./draft-revision";
import {assembleMigration} from "./authoring";
import type {AuthoringRuntime, CompiledAuthoringInfo, MigrationDraftInfo} from "./authoring-contract";
import {AuthoringFiles} from "./authoring-files";
import {runAddSqlSession, type AddSqlContractInfo} from "./authoring-cli";
import {databaseProvisioningSql, appPermissionSql} from "./database-permissions";
import {saveMigrationArtifact} from "./migration-artifact";
import {isSafeArtifactPath} from "./artifact-files";
import {captureMigrationState, initializeMigrationStore, invalidStore, jsonBytes, migrationDirectory, readCatalogState, readStateBytes, stateFile, stateReference, writeJsonAtomic} from "./migration-store";

export type SsotAuthoringRuntime = Pick<AuthoringRuntime, "readSql" | "readQuery" | "loadDataContext">;

export async function readMigrationDraft(file: string): Promise<ValidationResult<MigrationDraftInfo>> {
    const parsed = parseJsonBytes(await readFile(file), file, false);
    if (!parsed.ok) return parsed;
    const decoded = decodeMigrationDraftInfo(parsed.value);
    if (!decoded.ok) return decoded;
    const draft = decoded.value;
    const revision = computeDraftRevisionHash(draft);
    return revision.ok && revision.value !== draft.revisionHash ? invalidStore("Stale draft revision") : revision.ok ? {ok: true, value: draft} : revision;
}

export async function inferSsotMigration(system: SqlSsotInfo, settings: DatabaseSettings, root: string, id: string, draftFile: string, baselineDirectory?: string) {
    if (!isSafeArtifactPath(id) || id.includes("/")) return invalidStore("Migration id must be one safe directory name");
    const catalog = await initializeMigrationStore(root, system, settings.database.schema, baselineDirectory);
    if (!catalog.ok) return catalog;
    const sequence = String(catalog.value.migrations.length + 1).padStart(4, "0") + "_";
    id = id.startsWith(sequence) ? id : sequence + id;
    const from = await readCatalogState(root, catalog.value, catalog.value.migrations.length);
    const to = await captureMigrationState(system, settings.database.schema, id);
    if (!from.ok) return from;
    if (!to.ok) return to;
    const base = {from: catalog.value.releases[catalog.value.releases.length - 1], to: stateReference(to.value),
        fromSnapshotHash: sha256Hex(jsonBytes(from.value.ssot)), toSnapshotHash: sha256Hex(jsonBytes(to.value.ssot)),
        fromPersistenceHash: sha256Hex(jsonBytes(from.value.persistence)), toPersistenceHash: sha256Hex(jsonBytes(to.value.persistence))};
    const draft = createMigrationDraft(id, base, from.value.schema, system, settings.database.schema);
    if (!draft.ok) return draft;
    await mkdir(dirname(draftFile), {recursive: true});
    await writeJsonAtomic(draftFile + ".states.json", {from: from.value, to: to.value});
    await writeJsonAtomic(draftFile, draft.value);
    return draft;
}

export async function generateSsotMigration(system: SqlSsotInfo, settings: DatabaseSettings, root: string, draftFile: string, runtime: SsotAuthoringRuntime = {}, sql?: {text: string; contract: AddSqlContractInfo}) {
    const loaded = await readMigrationDraft(draftFile);
    if (!loaded.ok) return loaded;
    const states = parseJsonBytes(await readFile(draftFile + ".states.json"), "draft states");
    if (!states.ok) return states;
    if (!isPlainObject(states.value)) return invalidStore("Missing draft states");
    const from = await readStateBytes(jsonBytes(states.value.from)), to = await readStateBytes(jsonBytes(states.value.to));
    if (!from.ok) return from;
    if (!to.ok) return to;
    const current = await captureMigrationState(system, settings.database.schema, loaded.value.id);
    if (!current.ok) return current;
    if (stateReference(current.value).releaseHash !== stateReference(to.value).releaseHash) return invalidStore("SSOT changed since this draft was created");
    const catalog = await initializeMigrationStore(root, system, settings.database.schema);
    if (!catalog.ok) return catalog;
    if (!sameReleaseRef(loaded.value.base.from, catalog.value.releases[catalog.value.releases.length - 1])) return invalidStore("Draft does not extend the current catalog");
    if (!sameReleaseRef(loaded.value.base.to, stateReference(to.value))) return invalidStore("Draft target differs from its saved state");
    const expectedSource = await readCatalogState(root, catalog.value, catalog.value.migrations.length);
    if (!expectedSource.ok) return expectedSource;
    if (stateReference(expectedSource.value).releaseHash !== stateReference(from.value).releaseHash) return invalidStore("Draft source differs from the catalog", "migration.checksumMismatch");
    const bindings = [[loaded.value.base.fromSnapshotHash, from.value.ssot], [loaded.value.base.toSnapshotHash, to.value.ssot],
        [loaded.value.base.fromPersistenceHash, from.value.persistence], [loaded.value.base.toPersistenceHash, to.value.persistence]] as const;
    if (bindings.some(([hash, value]) => hash !== sha256Hex(jsonBytes(value)))) return invalidStore("Draft snapshot or SQL mapping binding changed", "migration.checksumMismatch");
    if (catalog.value.releases.some(release => release.releaseId === to.value.releaseId)) return invalidStore("Migration release id is already used");
    const files = new AuthoringFiles();
    let draft = loaded.value;
    if (sql !== undefined) {
        const ref = {name: sql.contract.resourceName, kind: "sql" as const, contentHash: sha256Hex(sql.text)};
        await files.emitResource({ref, text: sql.text});
        const result = await runAddSqlSession({draftPath: draftFile, store: {
            async readDraft() {return {ok: true, value: draft};},
            async replaceDraftAtomic(_file, next) {draft = next; await writeJsonAtomic(draftFile, next); return {ok: true, value: true};},
        }, file: {path: ref.name, text: sql.text}, contract: sql.contract});
        if (!result.ok) return {ok: false as const, problems: result.problems};
    }
    const readSql: NonNullable<AuthoringRuntime["readSql"]> = async ref => {
        const resource = files.resources.get(ref.name);
        if (resource !== undefined && resource.ref.contentHash === ref.contentHash) return {ok: true, value: resource.text};
        return runtime.readSql ? runtime.readSql(ref) : invalidStore("Missing authored SQL/check resource: " + ref.name);
    };
    const assembled = await assembleMigration(draft, from.value.schema, to.value.schema, {...runtime, readSql, emitResource: files.emitResource.bind(files)});
    if (!assembled.ok) return assembled;
    const savedStates = {from: stateFile("states/from.json", from.value), to: stateFile("states/to.json", to.value)};
    files.files.set(savedStates.from.path, jsonBytes(from.value));
    files.files.set(savedStates.to.path, jsonBytes(to.value));
    const compiled: CompiledAuthoringInfo = {...assembled.value, states: savedStates};
    const resource = async (name: string, text: string) => {
        const ref = {kind: "sql" as const, name, contentHash: sha256Hex(text)};
        await files.emitResource({ref, text});
        return ref;
    };
    if (catalog.value.migrations.length === 0 && Object.keys(from.value.ssot.entities).length === 0) {
        compiled.initial = await resource("initial-users.sql", databaseProvisioningSql(settings, settings.database.schema + "_migrations").join("\n"));
    }
    const grants = appPermissionSql(settings, to.value.schema).join("\n");
    if (grants !== "") {
        const run = await resource("app-permissions.sql", grants);
        compiled.migration = {...compiled.migration, steps: [...compiled.migration.steps, {id: "app-permissions", run}]};
        compiled.operations = [...compiled.operations, {id: "app-permissions", stepIds: ["app-permissions"], changeIds: [], dataMigrationIds: []}];
    }
    const prefix = String(catalog.value.migrations.length + 1).padStart(4, "0") + "_";
    const sqlName = (compiled.migration.id.startsWith(prefix) ? compiled.migration.id : prefix + compiled.migration.id) + ".sql";
    const published = await saveMigrationArtifact(migrationDirectory(root, {migration: compiled.migration, migrationHash: "0".repeat(64)}), compiled, files, sqlName);
    if (!published.ok) return published;
    const next = completeMigrationCatalog([...catalog.value.releases, published.value.migration.to], [...catalog.value.migrations, published.value]);
    if (!next.ok) return next;
    await writeJsonAtomic(join(root, "catalog.json"), {...next.value, ...(catalog.value.baselineDirectory === undefined ? {} : {baselineDirectory: catalog.value.baselineDirectory})}, true);
    if (draftFile === join(root, "draft.json")) {await unlink(draftFile); await unlink(draftFile + ".states.json");}
    return published;
}

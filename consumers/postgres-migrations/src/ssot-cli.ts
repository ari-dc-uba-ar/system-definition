import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {isPlainObject, type ValidationResult} from "system-definition";
import {loadSsot} from "./ssot";
import {loadDatabaseSettings} from "./database-settings";
import {parseJsonBytes} from "./artifact";
import {inferSsotMigration, generateSsotMigration, readMigrationDraft, type SsotAuthoringRuntime} from "./ssot-authoring";
import {decodeAddSqlContract} from "./authoring-cli";
import {captureMigrationState, initializeMigrationStore, invalidStore, readCatalogState, readStoredCatalog, stateReference} from "./migration-store";
import {applyMigrations} from "./apply-migrations";

export type SsotCommandOptions = {ssot: string; database: string; directory: string; draft: string; baseline?: string};
type SqlFiles = {file: string; contract: string};
export type SsotAuthoringOptions = SsotCommandOptions & (
    | {command: "infer"; id: string}
    | {command: "generate"; sql?: SqlFiles}
    | {command: "data"; id: string; sql: SqlFiles}
);
export type SsotApplyOptions = SsotCommandOptions & {id?: string};

export async function loadMigrationInputs(options: Pick<SsotCommandOptions, "ssot" | "database">) {
    const system = await loadSsot(options.ssot), settings = await loadDatabaseSettings(options.database);
    if (!system.ok) return system;
    return settings.ok ? {ok: true as const, value: {system: system.value, settings: settings.value}} : settings;
}

async function generate(options: SsotCommandOptions & {sql?: SqlFiles}, inputs: Extract<Awaited<ReturnType<typeof loadMigrationInputs>>, {ok: true}>["value"]) {
    const module = await import(pathToFileURL(resolve(options.ssot)).href);
    const supplied: unknown = module.migrationAuthoring;
    if (supplied !== undefined && (!isPlainObject(supplied) || ["readSql", "readQuery", "loadDataContext"].some(key => supplied[key] !== undefined && typeof supplied[key] !== "function"))) return invalidStore("migrationAuthoring must supply typed SQL/query/data readers");
    let sql;
    if (options.sql !== undefined) {
        const parsed = parseJsonBytes(await readFile(options.sql.contract), options.sql.contract, false);
        if (!parsed.ok) return parsed;
        const contract = decodeAddSqlContract(parsed.value);
        if (!contract.ok) return contract;
        sql = {text: await readFile(options.sql.file, "utf8"), contract: contract.value};
    }
    return generateSsotMigration(inputs.system, inputs.settings, options.directory, options.draft, (supplied ?? {}) as SsotAuthoringRuntime, sql);
}

/** Command-specific required inputs are validated by the CLI before dispatch. */
export async function dispatchSsotAuthoring(options: SsotAuthoringOptions): Promise<ValidationResult<unknown>> {
    const loaded = await loadMigrationInputs(options);
    if (!loaded.ok) return loaded;
    const {system, settings} = loaded.value;
    if (options.command !== "generate") {
        const inferred = await inferSsotMigration(system, settings, options.directory, options.id, options.draft, options.baseline);
        if (!inferred.ok || options.command === "infer") return inferred;
        if (inferred.value.changes.length > 0) return invalidStore("Standalone data migrations require an unchanged schema; generate the schema migration first");
    }
    return generate(options, loaded.value);
}

/** Reuse authoring; apply consumes only immutable catalog entries. */
export async function dispatchSsotApply(options: SsotApplyOptions): Promise<ValidationResult<unknown>> {
    const loaded = await loadMigrationInputs(options);
    if (!loaded.ok) return loaded;
    const {system, settings} = loaded.value, root = options.directory;
    const catalog = await initializeMigrationStore(root, system, settings.database.schema, options.baseline);
    if (!catalog.ok) return catalog;
    const last = await readCatalogState(root, catalog.value, catalog.value.migrations.length);
    if (!last.ok) return last;
    const desired = await captureMigrationState(system, settings.database.schema, last.value.releaseId);
    if (!desired.ok) return desired;
    let existing: Awaited<ReturnType<typeof readMigrationDraft>> | undefined;
    try {existing = await readMigrationDraft(options.draft);}
    catch (error) {if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;}
    if (existing !== undefined && !existing.ok) return existing;
    const existingId = existing?.value.id;
    const unpublished = existingId !== undefined && !catalog.value.migrations.some(migration => migration.migration.id === existingId);
    if (unpublished || stateReference(last.value).releaseHash !== stateReference(desired.value).releaseHash) {
        if (!unpublished) {
            const id = options.id ?? (catalog.value.migrations.length === 0 && catalog.value.releases[0].releaseId === "empty" ? "initial" : "migration-" + randomUUID());
            const inferred = await inferSsotMigration(system, settings, root, id, options.draft, options.baseline);
            if (!inferred.ok) return inferred;
        }
        const generated = await generate(options, loaded.value);
        if (!generated.ok) return generated;
    }
    const ready = await readStoredCatalog(root);
    return ready.ok ? applyMigrations(root, ready.value, settings) : ready;
}

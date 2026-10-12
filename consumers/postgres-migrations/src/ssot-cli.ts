import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {isPlainObject, type ValidationResult} from "system-definition";
import {loadSsot} from "./ssot";
import {loadDatabaseSettings} from "./database-settings";
import {parseJsonBytes} from "./artifact";
import {inferSsotMigration, generateSsotMigration, readMigrationDraft, type SsotAuthoringRuntime} from "./ssot-authoring";
import type {AddSqlContractInfo} from "./authoring-cli";
import {captureMigrationState, initializeMigrationStore, invalidStore, readCatalogState, readStoredCatalog, stateReference} from "./migration-store";
import {applyMigrations} from "./apply-migrations";

/** Schema/data authoring from SSOT inputs; this command path never executes migrations. */
export async function dispatchSsotAuthoring(command: string, flags: ReadonlyMap<string, string>): Promise<ValidationResult<unknown>> {
    const ssotFile = flags.get("ssot"), databaseFile = flags.get("database");
    if (!ssotFile || !databaseFile) return invalidStore("Supply --ssot and --database", "migration.invalidExecutionOptions");
    const ssot = await loadSsot(ssotFile), settings = await loadDatabaseSettings(databaseFile);
    if (!ssot.ok) return ssot;
    if (!settings.ok) return settings;
    const root = resolve(flags.get("directory") ?? "migrations"), draftFile = resolve(flags.get("draft") ?? join(root, "draft.json"));
    if (command === "infer" || command === "data") {
        const id = flags.get("id");
        if (!id) return invalidStore("Supply --id for the migration", "migration.invalidExecutionOptions");
        const inferred = await inferSsotMigration(ssot.value, settings.value, root, id, draftFile, flags.get("baseline"));
        if (!inferred.ok || command === "infer") return inferred;
        if (inferred.value.changes.length > 0) return invalidStore("Standalone data migrations require an unchanged schema; generate the schema migration first");
    }
    if (command !== "generate" && command !== "data") return invalidStore("Unsupported SSOT authoring command");
    const module = await import(pathToFileURL(resolve(ssotFile)).href);
    const supplied: unknown = module.migrationAuthoring;
    if (supplied !== undefined && (!isPlainObject(supplied) || ["readSql", "readQuery", "loadDataContext"].some(key => supplied[key] !== undefined && typeof supplied[key] !== "function"))) return invalidStore("migrationAuthoring must supply typed SQL/query/data readers");
    const runtime = (supplied ?? {}) as SsotAuthoringRuntime;
    let sql: {text: string; contract: AddSqlContractInfo} | undefined;
    if (flags.has("sql")) {
        const contractFile = flags.get("contract");
        if (!contractFile) return invalidStore("--sql requires an explicit --contract", "migration.invalidExecutionOptions");
        const contract = parseJsonBytes(await readFile(resolve(contractFile)), contractFile, false);
        if (!contract.ok) return contract;
        const raw = contract.value;
        if (!isPlainObject(raw) || typeof raw.id !== "string" || typeof raw.resourceName !== "string"
            || !["dependsOn", "implementsChanges", "reads", "writes", "destroys", "before", "after", "rowChecks"].every(key => Array.isArray(raw[key]))) return invalidStore("Malformed manual SQL effect contract");
        sql = {text: await readFile(resolve(flags.get("sql")!), "utf8"), contract: raw as unknown as AddSqlContractInfo};
    }
    if (command === "data" && sql === undefined) return invalidStore("Standalone data authoring requires --sql and --contract", "migration.invalidExecutionOptions");
    return generateSsotMigration(ssot.value, settings.value, root, draftFile, runtime, sql);
}

/** Reuse authoring to save reviewed work; apply consumes only immutable catalog entries. */
export async function dispatchSsotApply(flags: ReadonlyMap<string, string>): Promise<ValidationResult<unknown>> {
    const ssotFile = flags.get("ssot"), databaseFile = flags.get("database");
    if (!ssotFile || !databaseFile) return invalidStore("Supply --ssot and --database", "migration.invalidExecutionOptions");
    const system = await loadSsot(ssotFile), settings = await loadDatabaseSettings(databaseFile);
    if (!system.ok) return system;
    if (!settings.ok) return settings;
    const root = resolve(flags.get("directory") ?? "migrations"), draftFile = resolve(flags.get("draft") ?? join(root, "draft.json"));
    const catalog = await initializeMigrationStore(root, system.value, settings.value.database.schema, flags.get("baseline"));
    if (!catalog.ok) return catalog;
    const last = await readCatalogState(root, catalog.value, catalog.value.migrations.length);
    if (!last.ok) return last;
    const desired = await captureMigrationState(system.value, settings.value.database.schema, last.value.releaseId);
    if (!desired.ok) return desired;
    let existing;
    try {existing = await readMigrationDraft(draftFile);}
    catch (error) {if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;}
    const unpublished = existing?.ok && !catalog.value.migrations.some(migration => migration.migration.id === existing.value.id);
    if (unpublished || stateReference(last.value).releaseHash !== stateReference(desired.value).releaseHash) {
        if (!unpublished) {
            if (existing !== undefined && !existing.ok) return existing;
            const id = flags.get("id") ?? (catalog.value.migrations.length === 0 && catalog.value.releases[0].releaseId === "empty" ? "initial" : "migration-" + randomUUID());
            const inferred = await inferSsotMigration(system.value, settings.value, root, id, draftFile, flags.get("baseline"));
            if (!inferred.ok) return inferred;
        }
        const generated = await dispatchSsotAuthoring("generate", new Map([...flags, ["draft", draftFile], ["directory", root]]));
        if (!generated.ok) return generated;
    }
    const ready = await readStoredCatalog(root);
    return ready.ok ? applyMigrations(root, ready.value, settings.value) : ready;
}

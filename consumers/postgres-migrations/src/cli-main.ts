#!/usr/bin/env node
import {existsSync} from "node:fs";
import {mkdir, readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {CLI_COMMANDS, cliExitCode, type CliCommand} from "./cli";
import type {ValidationResult} from "system-definition";
import {loadSsot} from "./ssot";
import {assessDatabase} from "./assessment";
import {dispatchSsotAuthoring, dispatchSsotApply, loadMigrationInputs} from "./ssot-cli";
import {readMigrationDraft} from "./ssot-authoring";
import {collectMigrationDecisions} from "./migration-decisions";
import {invalidStore, readStoredCatalog, writeJsonAtomic} from "./migration-store";
import {migrationStatus} from "./apply-migrations";

type Flags = ReadonlyMap<string, string>;
const help = `postgres-migrations <command> --ssot <module.js> --database <module.js> [options]
Commands: ${CLI_COMMANDS.join(", ")}
--directory <path>    Migration catalog and entries (default: migrations).
--draft <file.json>   Editable migration draft (default: <directory>/draft.json).
--id <name>           Migration id for infer/data; optional for implicit apply generation.
--baseline <path>     Import an existing immutable initial release once.
--answers <file.json> Draft-bound decisions for resolve; resolve requires no SSOT module.
--sql <file.sql> --contract <file.json>  Explicit standalone data SQL and effects.
--out <file.json>     Save the command result as JSON.
--non-interactive    Accepted for automation; commands never read stdin.
apply generates unresolved work for review, verifies artifacts/history/drift, and uses owner.
Initial roles use initialUser; the application uses appUser. Credentials are omitted from output.
Exit codes: 0 success, 2 input/configuration, 3 verification, 4 execution/conflict.
`;
function required(flags: Flags, name: string): string {
    const value = flags.get(name);
    if (value === undefined) throw new Error("Supply --" + name);
    return value;
}
function options(flags: Flags) {
    const directory = resolve(flags.get("directory") ?? "migrations");
    return {ssot: required(flags, "ssot"), database: required(flags, "database"), directory,
        draft: resolve(flags.get("draft") ?? join(directory, "draft.json")), baseline: flags.get("baseline")};
}
function sqlFiles(flags: Flags) {
    return {file: resolve(required(flags, "sql")), contract: resolve(required(flags, "contract"))};
}
const handlers: Record<CliCommand, (flags: Flags) => Promise<ValidationResult<unknown>>> = {
    async capture(flags) {
        const ssot = required(flags, "ssot");
        if (!flags.has("database")) return loadSsot(ssot);
        const loaded = await loadMigrationInputs({ssot, database: required(flags, "database")});
        if (!loaded.ok) return loaded;
        const {system, settings: {database, initialUser, owner, appUser}} = loaded.value;
        return {ok: true, value: {...system, database: {database: {host: database.host, port: database.port, database: database.database, schema: database.schema},
            initialUser: {user: initialUser.user}, owner: {user: owner.user}, appUser: {user: appUser.user}}}};
    },
    async assess(flags) {
        const loaded = await loadMigrationInputs(options(flags));
        return loaded.ok ? assessDatabase(loaded.value.system, loaded.value.settings) : loaded;
    },
    infer: flags => dispatchSsotAuthoring({...options(flags), command: "infer", id: required(flags, "id")}),
    generate: flags => dispatchSsotAuthoring({...options(flags), command: "generate", sql: flags.has("sql") || flags.has("contract") ? sqlFiles(flags) : undefined}),
    data: flags => dispatchSsotAuthoring({...options(flags), command: "data", id: required(flags, "id"), sql: sqlFiles(flags)}),
    async resolve(flags) {
        const draftFile = resolve(required(flags, "draft")), answersFile = resolve(required(flags, "answers"));
        const draft = await readMigrationDraft(draftFile);
        if (!draft.ok) return draft;
        const decided = collectMigrationDecisions(draft.value, JSON.parse(await readFile(answersFile, "utf8")));
        if (decided.ok) await writeJsonAtomic(draftFile, decided.value);
        return decided;
    },
    async status(flags) {
        const input = options(flags), loaded = await loadMigrationInputs(input);
        if (!loaded.ok) return loaded;
        const catalog = await readStoredCatalog(input.directory);
        return catalog.ok ? migrationStatus(input.directory, catalog.value, loaded.value.settings) : catalog;
    },
    apply: flags => dispatchSsotApply({...options(flags), id: flags.get("id")}),
};
export async function main(argv: readonly string[]): Promise<number> {
    if (argv.length === 0 || argv.includes("--help")) {process.stdout.write(help); return 0;}
    const env = resolve(".env");
    if (existsSync(env)) process.loadEnvFile(env);
    let result: ValidationResult<unknown>;
    try {
        const command = CLI_COMMANDS.find(command => command === argv[0]);
        if (!command) throw new Error("Unknown command: " + argv[0]);
        const flags = new Map<string, string>();
        const allowed = new Set(["ssot", "database", "directory", "draft", "id", "baseline", "answers", "sql", "contract", "out", "non-interactive"]);
        for (let index = 1; index < argv.length; index++) {
            const key = argv[index]!.replace(/^--/, "");
            if (!argv[index]!.startsWith("--") || !allowed.has(key) || flags.has(key)) throw new Error("Invalid or repeated option: " + argv[index]);
            const value = key === "non-interactive" ? "true" : argv[++index];
            if (value === undefined || value.startsWith("--")) throw new Error("Missing value for --" + key);
            flags.set(key, value);
        }
        if (flags.has("out") && ["draft", "answers", "ssot", "database"].some(key => flags.has(key) && resolve(flags.get(key)!) === resolve(flags.get("out")!))) throw new Error("--out must differ from input files");
        result = await handlers[command](flags);
        if (flags.has("out")) {const out = resolve(flags.get("out")!); await mkdir(dirname(out), {recursive: true}); await writeJsonAtomic(out, result);}
    } catch (error) {result = invalidStore(error instanceof Error ? error.message : String(error), "migration.invalidExecutionOptions");}
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return cliExitCode(result);
}
if (require.main === module) main(process.argv.slice(2)).then(code => {process.exitCode = code;}).catch(error => {process.stderr.write(String(error)); process.exitCode = 4;});

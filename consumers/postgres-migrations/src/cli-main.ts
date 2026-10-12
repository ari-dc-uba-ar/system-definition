#!/usr/bin/env node
import {existsSync} from "node:fs";
import {mkdir, readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {CLI_COMMANDS, cliExitCode, type CliCommand} from "./cli";
import type {ValidationResult} from "system-definition";
import {loadSsot} from "./ssot";
import {loadDatabaseSettings} from "./database-settings";
import {assessDatabase} from "./assessment";
import {dispatchSsotAuthoring, dispatchSsotApply} from "./ssot-cli";
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
async function inputs(flags: Flags) {
    const file = flags.get("ssot");
    if (!file) return invalidStore("Supply --ssot", "migration.invalidExecutionOptions");
    const ssot = await loadSsot(file);
    if (!ssot.ok) return ssot;
    const database = flags.get("database");
    if (!database) return invalidStore("Supply --database", "migration.invalidExecutionOptions");
    const settings = await loadDatabaseSettings(database);
    return settings.ok ? {ok: true as const, value: {ssot: ssot.value, settings: settings.value}} : settings;
}
const handlers: Record<CliCommand, (flags: Flags) => Promise<ValidationResult<unknown>>> = {
    async capture(flags) {
        if (!flags.has("ssot")) return invalidStore("capture requires --ssot", "migration.invalidExecutionOptions");
        if (!flags.has("database")) return loadSsot(flags.get("ssot")!);
        const loaded = await inputs(flags);
        if (!loaded.ok) return loaded;
        const {ssot, settings: {database, initialUser, owner, appUser}} = loaded.value;
        return {ok: true, value: {...ssot, database: {database: {host: database.host, port: database.port, database: database.database, schema: database.schema},
            initialUser: {user: initialUser.user}, owner: {user: owner.user}, appUser: {user: appUser.user}}}};
    },
    async assess(flags) {
        if (!flags.has("ssot")) return invalidStore("assess requires --ssot", "migration.invalidExecutionOptions");
        const loaded = await inputs(flags);
        return loaded.ok ? assessDatabase(loaded.value.ssot, loaded.value.settings) : loaded;
    },
    infer: flags => dispatchSsotAuthoring("infer", flags),
    generate: flags => dispatchSsotAuthoring("generate", flags),
    data: flags => dispatchSsotAuthoring("data", flags),
    async resolve(flags) {
        const draftFile = flags.get("draft"), answersFile = flags.get("answers");
        if (!draftFile || !answersFile) return invalidStore("resolve requires --draft and --answers", "migration.invalidExecutionOptions");
        const draft = await readMigrationDraft(resolve(draftFile));
        if (!draft.ok) return draft;
        const decided = collectMigrationDecisions(draft.value, JSON.parse(await readFile(resolve(answersFile), "utf8")));
        if (decided.ok) await writeJsonAtomic(resolve(draftFile), decided.value);
        return decided;
    },
    async status(flags) {
        const loaded = await inputs(flags);
        if (!loaded.ok) return loaded;
        const root = resolve(flags.get("directory") ?? "migrations"), catalog = await readStoredCatalog(root);
        return catalog.ok ? migrationStatus(root, catalog.value, loaded.value.settings) : catalog;
    },
    apply: flags => dispatchSsotApply(flags),
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

import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import type {ClientConfig} from "pg";
import {isPlainObject, isNonBlankString, problem, type ValidationResult} from "system-definition";

export type DatabaseSettings = {
    database: ClientConfig & {database: string};
    owner: string;
    appUser: string;
};

export async function loadDatabaseSettings(file: string): Promise<ValidationResult<DatabaseSettings>> {
    const module = await import(pathToFileURL(resolve(file)).href);
    const settings: unknown = module.databaseSettings;
    if (!isPlainObject(settings) || !isPlainObject(settings.database) || !isNonBlankString(settings.database.database)
        || !isNonBlankString(settings.owner) || !isNonBlankString(settings.appUser) || settings.owner === settings.appUser) {
        return {ok: false, problems: [problem(null, "migration.invalidExecutionOptions", "blocking", {
            reason: "Supply databaseSettings with a database, owner and distinct appUser",
        })]};
    }
    return {ok: true, value: {database: {...settings.database, database: settings.database.database}, owner: settings.owner, appUser: settings.appUser}};
}

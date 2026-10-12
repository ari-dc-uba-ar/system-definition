import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import type {ClientConfig} from "pg";
import {isPlainObject, isNonBlankString, problem, type ValidationResult} from "system-definition";

export type DatabaseSettings = {
    database: ClientConfig & {database: string; schema: string};
    initialUser: ClientConfig & {user: string};
    owner: ClientConfig & {user: string};
    appUser: ClientConfig & {user: string};
};

const isConnection = (value: unknown): value is DatabaseSettings["initialUser"] => isPlainObject(value) && isNonBlankString(value.user);

export async function loadDatabaseSettings(file: string): Promise<ValidationResult<DatabaseSettings>> {
    const module = await import(pathToFileURL(resolve(file)).href);
    const settings: unknown = module.databaseSettings;
    if (!isPlainObject(settings) || !isPlainObject(settings.database) || !isNonBlankString(settings.database.database) || !isNonBlankString(settings.database.schema)
        || !isConnection(settings.initialUser) || !isConnection(settings.owner) || !isConnection(settings.appUser)
        || settings.owner.user === settings.appUser.user) {
        return {ok: false, problems: [problem(null, "migration.invalidExecutionOptions", "blocking", {
            reason: "Supply databaseSettings with database/schema, initialUser connection, owner and distinct appUser",
        })]};
    }
    return {ok: true, value: {
        database: {...settings.database, database: settings.database.database, schema: settings.database.schema},
        initialUser: {...settings.initialUser}, owner: {...settings.owner}, appUser: {...settings.appUser},
    }};
}

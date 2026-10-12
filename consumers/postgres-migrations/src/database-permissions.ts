import {problem, type ValidationResult} from "system-definition";
import type {DatabaseSettings} from "./database-settings";
import type {PgSchemaInfo, PgSession} from "./pg-schema";
import {quotePgIdentifier as quote} from "./pg-sql";

function invalid(reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.permissionsInvalid", "blocking", {reason})]};
}

/** Initial administrative connection; no data/schema migration is executed here. */
export async function provisionDatabase(session: PgSession, settings: DatabaseSettings, journalSchema?: string): Promise<ValidationResult<true>> {
    const {owner, appUser, database} = settings;
    const existing = await session.query("SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ($1, $2)", [owner.user, appUser.user]);
    if (existing.rows.some(row => row.rolcanlogin !== true)) return invalid("Configured connection roles must allow login");
    const app = existing.rows.find(row => row.rolname === appUser.user);
    if (app && [app.rolsuper, app.rolcreatedb, app.rolcreaterole, app.rolreplication, app.rolbypassrls].some(flag => flag === true)) return invalid("The existing app role has administrative privileges");
    await session.query("BEGIN", []);
    try {
        for (const connection of [owner, appUser]) {
            if (existing.rows.some(row => row.rolname === connection.user)) continue;
            const password = typeof connection.password === "function" ? await connection.password() : connection.password ?? null;
            const formatted = await session.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql", [connection.user, password]);
            const sql = formatted.rows[0]?.sql;
            if (typeof sql !== "string") throw new Error("Could not format role creation");
            await session.query(sql, []);
        }
        const schema = quote(database.schema), ownerName = quote(owner.user), appName = quote(appUser.user);
        for (const namespace of new Set([database.schema, ...(journalSchema === undefined ? [] : [journalSchema])])) {
            await session.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)} AUTHORIZATION ${ownerName}`, []);
            const ownership = await session.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [namespace]);
            if (ownership.rows[0]?.owner !== owner.user) throw new Error("Configured schema belongs to a different owner");
        }
        for (const sql of [
            `REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${appName}`,
            `GRANT USAGE ON SCHEMA ${schema} TO ${appName}`,
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appName}`,
        ]) await session.query(sql, []);
        await session.query("COMMIT", []);
        return {ok: true, value: true};
    } catch (error) {
        await session.query("ROLLBACK", []);
        return invalid(error instanceof Error ? error.message : String(error));
    }
}

/** Current and future managed tables receive the same data-only app privileges. */
export async function grantAppPermissions(session: PgSession, settings: DatabaseSettings, expected: PgSchemaInfo): Promise<ValidationResult<true>> {
    for (const object of expected.objects) {
        if (object.kind !== "table") continue;
        const name = `${quote(object.identity.schema)}.${quote(object.identity.name)}`;
        await session.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${name} TO ${quote(settings.appUser.user)}`, []);
    }
    return {ok: true, value: true};
}

/** Read-only verification against the declared identities and every managed table. */
export async function verifyDatabasePermissions(session: PgSession, settings: DatabaseSettings, expected: PgSchemaInfo): Promise<ValidationResult<true>> {
    const tables = expected.objects.filter(object => object.kind === "table").map(object => object.identity.name);
    const checked = await session.query(`SELECT
        current_user = $1 AND pg_get_userbyid(n.nspowner) = $1
        AND has_schema_privilege($1, n.oid, 'USAGE') AND has_schema_privilege($1, n.oid, 'CREATE')
        AND has_schema_privilege($2, n.oid, 'USAGE') AND NOT has_schema_privilege($2, n.oid, 'CREATE')
        AND NOT pg_has_role($2, $1, 'MEMBER')
        AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = $2 AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
        AND NOT EXISTS (
            SELECT FROM jsonb_array_elements_text($4::jsonb) AS wanted(name)
            LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = wanted.name AND c.relkind = 'r'
            WHERE c.oid IS NULL OR pg_get_userbyid(c.relowner) <> $1
                OR NOT has_table_privilege($2, c.oid, 'SELECT') OR NOT has_table_privilege($2, c.oid, 'INSERT')
                OR NOT has_table_privilege($2, c.oid, 'UPDATE') OR NOT has_table_privilege($2, c.oid, 'DELETE')
        ) AS ok FROM pg_namespace n WHERE n.nspname = $3`, [settings.owner.user, settings.appUser.user, settings.database.schema, JSON.stringify(tables)]);
    return checked.rows.length === 1 && checked.rows[0]?.ok === true ? {ok: true, value: true} : invalid("Owner/app ownership or privileges differ from the configured policy");
}

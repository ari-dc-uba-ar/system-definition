import {problem, type ValidationResult} from "system-definition";
import type {DatabaseSettings} from "./database-settings";
import type {PgSchemaInfo, PgSession} from "./pg-schema";
import type {StructureChangeInfo} from "./authoring-contract";
import {quotePgIdentifier as quote, quotePgLiteral as literal} from "./pg-sql";

function invalid(reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.permissionsInvalid", "blocking", {reason})]};
}

/** Pure initial setup SQL; passwords come from transaction-local values at apply time. */
export function databaseProvisioningSql(settings: DatabaseSettings, journalSchema?: string): readonly string[] {
    const {owner, appUser, database} = settings;
    const roleSql = (user: string, passwordSetting: string) => {
        const body = `BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(user)}) THEN
        CREATE ROLE ${quote(user)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        EXECUTE format('ALTER ROLE %I PASSWORD %L', ${literal(user)}, NULLIF(current_setting('${passwordSetting}', true), ''));
    END IF;
END;`;
        let tag = "$roles$";
        while (body.includes(tag)) tag = tag.slice(0, -1) + "_$";
        return `DO ${tag}\n${body}\n${tag};\n`;
    };
    const schema = quote(database.schema), ownerName = quote(owner.user), appName = quote(appUser.user);
    return [
        roleSql(owner.user, "migration.owner_password"), roleSql(appUser.user, "migration.app_password"),
        ...[...new Set([database.schema, ...(journalSchema === undefined ? [] : [journalSchema])])].map(name =>
            `CREATE SCHEMA IF NOT EXISTS ${quote(name)} AUTHORIZATION ${ownerName};\n`),
        `REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC, ${appName};\n`,
        `GRANT USAGE ON SCHEMA ${schema} TO ${appName};\n`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerName} IN SCHEMA ${schema} REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${appName};\n`,
    ];
}
/** Only newly created managed tables receive automatic CRUD grants. */
export function appPermissionSql(settings: DatabaseSettings, changes: readonly StructureChangeInfo[]): readonly string[] {
    return changes.flatMap(change => change.action === "add" && change.after.kind === "table" ? [
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quote(change.after.schema)}.${quote(change.after.name)} TO ${quote(settings.appUser.user)};\n`,
    ] : []);
}

/** Initial administrative connection; no data/schema migration is executed here. */
export async function provisionDatabase(session: PgSession, settings: DatabaseSettings, journalSchema?: string, savedSql = databaseProvisioningSql(settings, journalSchema).join("\n")): Promise<ValidationResult<true>> {
    if (savedSql !== databaseProvisioningSql(settings, journalSchema).join("\n")) return invalid("Saved initial owner/app setup differs from database settings");
    const {owner, appUser, database} = settings;
    const existing = await session.query("SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ($1, $2)", [owner.user, appUser.user]);
    if (existing.rows.some(row => row.rolcanlogin !== true)) return invalid("Configured connection roles must allow login");
    const app = existing.rows.find(row => row.rolname === appUser.user);
    if (app && [app.rolsuper, app.rolcreatedb, app.rolcreaterole, app.rolreplication, app.rolbypassrls].some(flag => flag === true)) return invalid("The existing app role has administrative privileges");
    await session.query("BEGIN", []);
    try {
        const passwords = await Promise.all([owner.password, appUser.password].map(password => typeof password === "function" ? password() : password ?? ""));
        await session.query("SELECT set_config('migration.owner_password', $1, true), set_config('migration.app_password', $2, true)", passwords);
        await session.query(savedSql, []);
        for (const namespace of new Set([database.schema, ...(journalSchema === undefined ? [] : [journalSchema])])) {
            const ownership = await session.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [namespace]);
            if (ownership.rows[0]?.owner !== owner.user) throw new Error("Configured schema belongs to a different owner");
        }
        await session.query("COMMIT", []);
        return {ok: true, value: true};
    } catch (error) {
        await session.query("ROLLBACK", []);
        return invalid(error instanceof Error ? error.message : String(error));
    }
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

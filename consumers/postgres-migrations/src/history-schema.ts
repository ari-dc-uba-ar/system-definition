import type {ValidationResult} from "system-definition";
import {quotePgIdentifier, type PgSession} from "./pg-schema";
import type {JournalConfig} from "./journal-contracts";
import {safeQuery, validateConfig} from "./journal-internal";

/** History needs only a pointer and its committed sequence. */
export function historySchemaStatements(schemaName: string): readonly string[] {
    const schema = quotePgIdentifier(schemaName);
    return [
        `CREATE SCHEMA IF NOT EXISTS ${schema}`,
        `CREATE TABLE IF NOT EXISTS ${schema}.installation (
            installation_id text PRIMARY KEY,
            system_id text NOT NULL,
            schemas text[] NOT NULL,
            baseline_system_id text NOT NULL,
            baseline_release_id text NOT NULL,
            baseline_release_hash text NOT NULL,
            current_system_id text NOT NULL,
            current_release_id text NOT NULL,
            current_release_hash text NOT NULL,
            journal_format_version integer NOT NULL CHECK (journal_format_version = 1),
            UNIQUE (system_id, schemas)
        )`,
        `CREATE TABLE IF NOT EXISTS ${schema}.migration_history (
            installation_id text NOT NULL REFERENCES ${schema}.installation(installation_id),
            ordinal integer NOT NULL CHECK (ordinal > 0),
            migration_id text NOT NULL,
            migration_hash text NOT NULL,
            from_system_id text NOT NULL,
            from_release_id text NOT NULL,
            from_release_hash text NOT NULL,
            to_system_id text NOT NULL,
            to_release_id text NOT NULL,
            to_release_hash text NOT NULL,
            committed_at text NOT NULL,
            PRIMARY KEY (installation_id, ordinal),
            UNIQUE (installation_id, migration_id)
        )`,
    ];
}

export async function bootstrapHistory(session: PgSession, config: JournalConfig): Promise<ValidationResult<true>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    for (const sql of historySchemaStatements(checked.value.schema)) {
        const result = await safeQuery(session, sql, []);
        if (!result.ok) return result;
    }
    return {ok: true, value: true};
}

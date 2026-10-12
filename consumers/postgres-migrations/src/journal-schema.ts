import {historySchemaStatements} from "./history-schema";
import type {ValidationResult} from "system-definition";
import {quotePgIdentifier, type PgSession} from "./pg-schema";
import {ATTEMPT_STATES, type JournalConfig} from "./journal-contracts";
import {safeQuery, sqlAttemptStates, validateConfig} from "./journal-internal";

function executionAttemptTable(schema: string): string {
    const attemptStatesSql = sqlAttemptStates(ATTEMPT_STATES);
    return `CREATE TABLE IF NOT EXISTS ${schema}.execution_attempt (
            attempt_id text PRIMARY KEY,
            deployment_id text NOT NULL,
            installation_id text NOT NULL,
            plan_hash text NOT NULL,
            state text NOT NULL CHECK (state IN (${attemptStatesSql})),
            confirmed_target_system_id text NULL,
            confirmed_target_release_id text NULL,
            confirmed_target_release_hash text NULL,
            problems jsonb NOT NULL DEFAULT '[]'::jsonb,
            started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            finished_at timestamptz NULL
        )`;
}

/** Only pointer, committed history and execution failures are migration journal state. */
export async function bootstrapJournal(session: PgSession, config: JournalConfig): Promise<ValidationResult<true>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    const existing = await safeQuery(session, "SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = $1) AS present", [checked.value.schema]);
    if (!existing.ok) return existing;
    const history = historySchemaStatements(checked.value.schema);
    const statements = existing.value.rows[0]?.present === true ? history.slice(1) : history;
    for (const sql of [...statements, executionAttemptTable(quotePgIdentifier(checked.value.schema))]) {
        const result = await safeQuery(session, sql, []);
        if (!result.ok) return result;
    }
    return {ok: true, value: true};
}

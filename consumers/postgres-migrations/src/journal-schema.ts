import type {ValidationResult} from "system-definition";
import {quotePgIdentifier, type PgSession} from "./pg-schema";
import {ATTEMPT_STATES, type JournalConfig} from "./journal-contracts";
import {safeQuery, sqlAttemptStates, validateConfig} from "./journal-internal";

export async function bootstrapJournal(
    session: PgSession,
    config: JournalConfig,
): Promise<ValidationResult<true>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    const schema = quotePgIdentifier(checked.value.schema);

    const attemptStatesSql = sqlAttemptStates(ATTEMPT_STATES);
    const statements = [
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
        `CREATE TABLE IF NOT EXISTS ${schema}.execution_attempt (
            attempt_id text PRIMARY KEY,
            deployment_id text NOT NULL,
            installation_id text NOT NULL REFERENCES ${schema}.installation(installation_id),
            plan_hash text NOT NULL,
            state text NOT NULL CHECK (state IN (${attemptStatesSql})),
            confirmed_target_system_id text NULL,
            confirmed_target_release_id text NULL,
            confirmed_target_release_hash text NULL,
            problems jsonb NOT NULL DEFAULT '[]'::jsonb,
            started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            finished_at timestamptz NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${schema}.preparation_attempts (
            attempt_id text PRIMARY KEY,
            installation_id text NOT NULL REFERENCES ${schema}.installation(installation_id),
            preparation_id text NOT NULL,
            artifact_hash text NOT NULL,
            state text NOT NULL CHECK (state IN (${attemptStatesSql})),
            before_fingerprint text NOT NULL,
            after_fingerprint text NULL,
            report_hash text NOT NULL,
            problems jsonb NOT NULL DEFAULT '[]'::jsonb,
            started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            finished_at timestamptz NULL
        )`,
        `CREATE TABLE IF NOT EXISTS ${schema}.preparations (
            installation_id text NOT NULL REFERENCES ${schema}.installation(installation_id),
            ordinal integer NOT NULL CHECK (ordinal > 0),
            preparation_id text NOT NULL,
            artifact_hash text NOT NULL,
            head_system_id text NOT NULL,
            head_release_id text NOT NULL,
            head_release_hash text NOT NULL,
            before_fingerprint text NOT NULL,
            after_fingerprint text NOT NULL,
            report_hash text NOT NULL,
            committed_at text NOT NULL,
            PRIMARY KEY (installation_id, ordinal),
            UNIQUE (installation_id, preparation_id),
            UNIQUE (installation_id, artifact_hash)
        )`,
        `CREATE TABLE IF NOT EXISTS ${schema}.verification_run (
            verification_id text PRIMARY KEY,
            deployment_id text NOT NULL,
            ordinal integer NOT NULL CHECK (ordinal > 0),
            binding jsonb NOT NULL,
            status text NOT NULL CHECK (status IN ('passed','failed','incomplete')),
            checks jsonb NOT NULL,
            created_at text NOT NULL,
            UNIQUE (deployment_id, ordinal)
        )`,
        `CREATE TABLE IF NOT EXISTS ${schema}.deployment_readiness (
            deployment_id text PRIMARY KEY,
            installation_id text NOT NULL,
            binding jsonb NOT NULL,
            state text NOT NULL CHECK (state IN ('pending','blocked','ready','consumed')),
            verification_id text NULL,
            apply_attempt_id text NULL,
            confirmed_target_system_id text NULL,
            confirmed_target_release_id text NULL,
            confirmed_target_release_hash text NULL,
            problems jsonb NOT NULL DEFAULT '[]'::jsonb,
            updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )`,
    ];

    for (const statement of statements) {
        const result = await safeQuery(session, statement, []);
        if (!result.ok) return result;
    }
    return {ok: true, value: true};
}

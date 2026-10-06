import {type ValidationResult} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    DEPLOYMENT_READINESS_STATE,
    DEPLOYMENT_READINESS_STATES,
    type DeploymentReadinessConsumeInput,
    type DeploymentReadinessRecordInput,
    type DeploymentReadinessState,
    type JournalConfig,
} from "./journal-contracts";
import {failure, safeQuery, validateConfig, validateRelease} from "./journal-internal";

function isReadinessState(value: unknown): value is DeploymentReadinessState {
    return typeof value === "string" && DEPLOYMENT_READINESS_STATES.includes(value as DeploymentReadinessState);
}

function validOptionalId(value: string | null): boolean {
    return value === null || isPgNonEmptyText(value);
}

export async function upsertDeploymentReadiness(
    session: PgSession,
    config: JournalConfig,
    input: DeploymentReadinessRecordInput,
): Promise<ValidationResult<true>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(input.deploymentId)
        || !isPgNonEmptyText(input.installationId)
        || !isReadinessState(input.state)
        || !validOptionalId(input.verificationId)
        || !validOptionalId(input.applyAttemptId)) {
        return failure("migration.invalidJournal", {reason: "invalid deployment readiness input"});
    }
    if (input.confirmedTarget !== null) {
        const target = validateRelease(input.confirmedTarget);
        if (!target.ok) return target;
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.deployment_readiness`;
    const text = `INSERT INTO ${table} (
        deployment_id, installation_id, binding, state, verification_id, apply_attempt_id,
        confirmed_target_system_id, confirmed_target_release_id, confirmed_target_release_hash,
        problems, updated_at
    ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,clock_timestamp())
    ON CONFLICT (deployment_id) DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        binding = EXCLUDED.binding,
        state = EXCLUDED.state,
        verification_id = EXCLUDED.verification_id,
        apply_attempt_id = EXCLUDED.apply_attempt_id,
        confirmed_target_system_id = EXCLUDED.confirmed_target_system_id,
        confirmed_target_release_id = EXCLUDED.confirmed_target_release_id,
        confirmed_target_release_hash = EXCLUDED.confirmed_target_release_hash,
        problems = EXCLUDED.problems,
        updated_at = clock_timestamp()`;
    const values: readonly SqlParameter[] = [
        input.deploymentId,
        input.installationId,
        JSON.stringify(input.binding),
        input.state,
        input.verificationId,
        input.applyAttemptId,
        input.confirmedTarget?.systemId ?? null,
        input.confirmedTarget?.releaseId ?? null,
        input.confirmedTarget?.releaseHash ?? null,
        JSON.stringify(input.problems),
    ];
    const result = await safeQuery(session, text, values);
    if (!result.ok) return result;
    return {ok: true, value: true};
}

export async function consumeDeploymentReadiness(
    session: PgSession,
    config: JournalConfig,
    input: DeploymentReadinessConsumeInput,
): Promise<ValidationResult<true>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(input.deploymentId)
        || !isPgNonEmptyText(input.installationId)
        || !isPgNonEmptyText(input.verificationId)
        || !isPgNonEmptyText(input.applyAttemptId)) {
        return failure("migration.invalidJournal", {reason: "invalid readiness consumption input"});
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.deployment_readiness`;
    const result = await safeQuery(session, `UPDATE ${table}
        SET state = $6, updated_at = clock_timestamp()
        WHERE deployment_id = $1
          AND installation_id = $2
          AND state = $7
          AND verification_id = $3
          AND apply_attempt_id = $4
          AND binding = $5::jsonb`, [
        input.deploymentId,
        input.installationId,
        input.verificationId,
        input.applyAttemptId,
        JSON.stringify(input.binding),
        DEPLOYMENT_READINESS_STATE.consumed,
        DEPLOYMENT_READINESS_STATE.ready,
    ]);
    if (!result.ok) return result;
    if (result.value.rowCount !== null && result.value.rowCount !== 1) {
        return failure("migration.invalidJournal", {reason: "ready deployment could not be consumed exactly once"});
    }
    return {ok: true, value: true};
}

import {
    isPlainObject,
    isSha256,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    ATTEMPT_STATE,
    type AttemptFinishInput,
    type AttemptInfo,
    type AttemptStartInput,
    type JournalConfig,
} from "./journal-contracts";
import {
    decodeProblems,
    decodeReleaseParts,
    failure,
    isAttemptState,
    isFinishedAttemptState,
    journalShape,
    safeQuery,
    sqlAttemptState,
    validateConfig,
    validateRelease,
    type Row,
} from "./journal-internal";

function decodeAttemptRow(value: unknown): ValidationResult<AttemptInfo> {
    const keys = [
        "attempt_id",
        "deployment_id",
        "installation_id",
        "plan_hash",
        "state",
        "confirmed_target_system_id",
        "confirmed_target_release_id",
        "confirmed_target_release_hash",
        "problems",
    ] as const;
    if (!isPlainObject(value)) return failure("migration.invalidJournal", {reason: "invalid execution attempt row"});
    const shape = journalShape(value, keys, "invalid execution attempt row");
    if (!shape.ok) return shape;
    if (!isPgNonEmptyText(value.attempt_id)
        || !isPgNonEmptyText(value.deployment_id)
        || !isPgNonEmptyText(value.installation_id)
        || !isSha256(value.plan_hash)
        || !isAttemptState(value.state)) {
        return failure("migration.invalidJournal", {reason: "invalid execution attempt row"});
    }
    const problems = decodeProblems(value.problems);
    if (!problems.ok) return problems;

    const targetParts = [
        value.confirmed_target_system_id,
        value.confirmed_target_release_id,
        value.confirmed_target_release_hash,
    ];
    let confirmedTarget: ReleaseRefInfo | null = null;
    if (!targetParts.every(one => one === null)) {
        if (targetParts.some(one => one === null)) {
            return failure("migration.invalidJournal", {reason: "partial confirmed target"});
        }
        const decoded = decodeReleaseParts(targetParts[0], targetParts[1], targetParts[2]);
        if (!decoded.ok) return decoded;
        confirmedTarget = decoded.value;
    }
    if (value.state === ATTEMPT_STATE.running && (confirmedTarget !== null || problems.value.length > 0)) {
        return failure("migration.invalidJournal", {reason: "running attempt cannot have a result"});
    }
    if (value.state === ATTEMPT_STATE.succeeded && confirmedTarget === null) {
        return failure("migration.invalidJournal", {reason: "succeeded attempt requires a confirmed target"});
    }
    return {
        ok: true,
        value: {
            attemptId: value.attempt_id,
            deploymentId: value.deployment_id,
            installationId: value.installation_id,
            planHash: value.plan_hash,
            state: value.state,
            confirmedTarget,
            problems: problems.value,
        },
    };
}

function attemptSelect(alias = "a"): string {
    return [
        `${alias}.attempt_id`,
        `${alias}.deployment_id`,
        `${alias}.installation_id`,
        `${alias}.plan_hash`,
        `${alias}.state`,
        `${alias}.confirmed_target_system_id`,
        `${alias}.confirmed_target_release_id`,
        `${alias}.confirmed_target_release_hash`,
        `${alias}.problems`,
    ].join(", ");
}

export async function startAttempt(
    session: PgSession,
    config: JournalConfig,
    input: AttemptStartInput,
): Promise<ValidationResult<AttemptInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPlainObject(input)) return failure("migration.invalidJournal", {reason: "invalid attempt start input"});
    const inputShape = journalShape(input, ["attemptId", "deploymentId", "installationId", "planHash"], "invalid attempt start input");
    if (!inputShape.ok) return inputShape;
    if (!isPgNonEmptyText(input.attemptId)
        || !isPgNonEmptyText(input.deploymentId)
        || !isPgNonEmptyText(input.installationId)
        || !isSha256(input.planHash)) {
        return failure("migration.invalidJournal", {reason: "invalid attempt start input"});
    }
    const schema = quotePgIdentifier(checked.value.schema);
    const text = `INSERT INTO ${schema}.execution_attempt (
        attempt_id, deployment_id, installation_id, plan_hash, state,
        confirmed_target_system_id, confirmed_target_release_id, confirmed_target_release_hash, problems
    ) VALUES ($1,$2,$3,$4,${sqlAttemptState(ATTEMPT_STATE.running)},NULL,NULL,NULL,'[]'::jsonb)
    RETURNING ${attemptSelect("execution_attempt")}`;
    const result = await safeQuery(session, text, [input.attemptId, input.deploymentId, input.installationId, input.planHash]);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) {
        return failure("migration.invalidJournal", {reason: "attempt insert did not return exactly one row"});
    }
    return decodeAttemptRow(result.value.rows[0]);
}

export async function finishAttempt(
    session: PgSession,
    config: JournalConfig,
    attemptId: string,
    resultInput: AttemptFinishInput,
): Promise<ValidationResult<AttemptInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(attemptId) || !isPlainObject(resultInput)) {
        return failure("migration.invalidJournal", {reason: "invalid attempt finish input"});
    }
    const inputShape = journalShape(resultInput, ["state", "confirmedTarget", "problems"], "invalid attempt finish input");
    if (!inputShape.ok) return inputShape;
    if (!isFinishedAttemptState(resultInput.state)) {
        return failure("migration.invalidJournal", {reason: "invalid attempt finish input"});
    }
    const problems = decodeProblems(resultInput.problems);
    if (!problems.ok) return problems;
    let confirmedTarget: ReleaseRefInfo | null = null;
    if (resultInput.confirmedTarget !== null) {
        const target = validateRelease(resultInput.confirmedTarget);
        if (!target.ok) return target;
        confirmedTarget = target.value;
    }
    if (resultInput.state === ATTEMPT_STATE.succeeded && confirmedTarget === null) {
        return failure("migration.invalidJournal", {reason: "succeeded attempt requires a confirmed target"});
    }
    const schema = quotePgIdentifier(checked.value.schema);
    const text = `UPDATE ${schema}.execution_attempt
        SET state = $2,
            confirmed_target_system_id = $3,
            confirmed_target_release_id = $4,
            confirmed_target_release_hash = $5,
            problems = $6::jsonb,
            finished_at = clock_timestamp()
        WHERE attempt_id = $1 AND state = ${sqlAttemptState(ATTEMPT_STATE.running)}
        RETURNING ${attemptSelect("execution_attempt")}`;
    const values: readonly SqlParameter[] = [
        attemptId,
        resultInput.state,
        confirmedTarget?.systemId ?? null,
        confirmedTarget?.releaseId ?? null,
        confirmedTarget?.releaseHash ?? null,
        JSON.stringify(problems.value),
    ];
    const result = await safeQuery(session, text, values);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) {
        return failure("migration.invalidJournal", {reason: "attempt is missing or already finished"});
    }
    return decodeAttemptRow(result.value.rows[0]);
}

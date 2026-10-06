import {
    isPlainObject,
    isSha256,
    type ValidationResult,
} from "system-definition";
import {quotePgIdentifier, type PgSession} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    ATTEMPT_STATE,
    type JournalConfig,
    type PreparationAttemptFinishInput,
    type PreparationAttemptInfo,
    type PreparationAttemptStartInput,
    type PreparationHistoryInfo,
} from "./journal-contracts";
import {
    UTC_RE,
    decodeProblems,
    decodeReleaseParts,
    failure,
    isAttemptState,
    isFinishedAttemptState,
    positiveInteger,
    safeQuery,
    sqlAttemptState,
    sqlAttemptStates,
    validateConfig,
    validateRelease,
} from "./journal-internal";

function preparationAttemptSelect(alias: string): string {
    return `${alias}.attempt_id, ${alias}.installation_id, ${alias}.preparation_id, ${alias}.artifact_hash,
        ${alias}.state, ${alias}.before_fingerprint, ${alias}.after_fingerprint, ${alias}.report_hash, ${alias}.problems`;
}

function decodePreparationAttemptRow(value: unknown): ValidationResult<PreparationAttemptInfo> {
    if (!isPlainObject(value)
        || !isPgNonEmptyText(value.attempt_id)
        || !isPgNonEmptyText(value.installation_id)
        || !isPgNonEmptyText(value.preparation_id)
        || !isSha256(value.artifact_hash)
        || !isAttemptState(value.state)
        || !isSha256(value.before_fingerprint)
        || !(value.after_fingerprint === null || isSha256(value.after_fingerprint))
        || !isSha256(value.report_hash)) {
        return failure("migration.invalidJournal", {reason: "invalid preparation attempt row"});
    }
    const problems = decodeProblems(value.problems);
    if (!problems.ok) return problems;
    return {
        ok: true,
        value: {
            attemptId: value.attempt_id,
            installationId: value.installation_id,
            preparationId: value.preparation_id,
            artifactHash: value.artifact_hash,
            state: value.state,
            beforeFingerprint: value.before_fingerprint,
            afterFingerprint: value.after_fingerprint,
            reportHash: value.report_hash,
            problems: problems.value,
        },
    };
}

function preparationSelect(alias: string): string {
    return `${alias}.installation_id, ${alias}.ordinal, ${alias}.preparation_id, ${alias}.artifact_hash,
        ${alias}.head_system_id, ${alias}.head_release_id, ${alias}.head_release_hash,
        ${alias}.before_fingerprint, ${alias}.after_fingerprint, ${alias}.report_hash, ${alias}.committed_at`;
}

function decodePreparationRow(value: unknown): ValidationResult<PreparationHistoryInfo> {
    if (!isPlainObject(value)
        || !isPgNonEmptyText(value.installation_id)
        || !positiveInteger(value.ordinal)
        || !isPgNonEmptyText(value.preparation_id)
        || !isSha256(value.artifact_hash)
        || !isSha256(value.before_fingerprint)
        || !isSha256(value.after_fingerprint)
        || !isSha256(value.report_hash)
        || typeof value.committed_at !== "string" || !UTC_RE.test(value.committed_at)) {
        return failure("migration.invalidJournal", {reason: "invalid confirmed preparation row"});
    }
    const head = decodeReleaseParts(value.head_system_id, value.head_release_id, value.head_release_hash);
    if (!head.ok) return head;
    return {
        ok: true,
        value: {
            installationId: value.installation_id,
            ordinal: value.ordinal,
            preparationId: value.preparation_id,
            artifactHash: value.artifact_hash,
            head: head.value,
            beforeFingerprint: value.before_fingerprint,
            afterFingerprint: value.after_fingerprint,
            reportHash: value.report_hash,
            committedAt: value.committed_at,
        },
    };
}

export async function startPreparationAttempt(
    session: PgSession,
    config: JournalConfig,
    input: PreparationAttemptStartInput,
): Promise<ValidationResult<PreparationAttemptInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPlainObject(input)
        || !isPgNonEmptyText(input.attemptId)
        || !isPgNonEmptyText(input.installationId)
        || !isPgNonEmptyText(input.preparationId)
        || !isSha256(input.artifactHash)
        || !isSha256(input.beforeFingerprint)
        || !isSha256(input.reportHash)) {
        return failure("migration.invalidJournal", {reason: "invalid preparation attempt input"});
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.preparation_attempts`;
    const result = await safeQuery(session, `INSERT INTO ${table} (
        attempt_id, installation_id, preparation_id, artifact_hash, state,
        before_fingerprint, after_fingerprint, report_hash, problems
    ) VALUES ($1,$2,$3,$4,${sqlAttemptState(ATTEMPT_STATE.running)},$5,NULL,$6,'[]'::jsonb)
    RETURNING ${preparationAttemptSelect("preparation_attempts")}`, [
        input.attemptId,
        input.installationId,
        input.preparationId,
        input.artifactHash,
        input.beforeFingerprint,
        input.reportHash,
    ]);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) return failure("migration.invalidJournal", {reason: "preparation attempt insert failed"});
    return decodePreparationAttemptRow(result.value.rows[0]);
}

export async function finishPreparationAttempt(
    session: PgSession,
    config: JournalConfig,
    attemptId: string,
    input: PreparationAttemptFinishInput,
): Promise<ValidationResult<PreparationAttemptInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(attemptId)
        || !isPlainObject(input)
        || !isFinishedAttemptState(input.state)
        || !(input.afterFingerprint === null || isSha256(input.afterFingerprint))
        || !Array.isArray(input.problems)) {
        return failure("migration.invalidJournal", {reason: "invalid preparation attempt finish input"});
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.preparation_attempts`;
    const result = await safeQuery(session, `UPDATE ${table}
        SET state=$2, after_fingerprint=$3, problems=$4::jsonb, finished_at=clock_timestamp()
        WHERE attempt_id=$1 AND state IN (${sqlAttemptStates([ATTEMPT_STATE.running, ATTEMPT_STATE.unknown])})
        RETURNING ${preparationAttemptSelect("preparation_attempts")}`, [
        attemptId,
        input.state,
        input.afterFingerprint,
        JSON.stringify(input.problems),
    ]);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) return failure("migration.invalidJournal", {reason: "preparation attempt missing or already finished"});
    return decodePreparationAttemptRow(result.value.rows[0]);
}

export async function readConfirmedPreparation(
    session: PgSession,
    config: JournalConfig,
    installationId: string,
    preparationId: string,
): Promise<ValidationResult<PreparationHistoryInfo | null>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(installationId) || !isPgNonEmptyText(preparationId)) {
        return failure("migration.invalidJournal", {reason: "invalid preparation lookup"});
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.preparations`;
    const result = await safeQuery(session, `SELECT ${preparationSelect("preparations")}
        FROM ${table} preparations
        WHERE installation_id=$1 AND preparation_id=$2`, [installationId, preparationId]);
    if (!result.ok) return result;
    if (result.value.rows.length === 0) return {ok: true, value: null};
    if (result.value.rows.length !== 1) return failure("migration.invalidJournal", {reason: "preparation lookup is not unique"});
    return decodePreparationRow(result.value.rows[0]);
}

export async function recordConfirmedPreparation(
    session: PgSession,
    config: JournalConfig,
    input: Omit<PreparationHistoryInfo, "ordinal">,
): Promise<ValidationResult<PreparationHistoryInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPlainObject(input)
        || !isPgNonEmptyText(input.installationId)
        || !isPgNonEmptyText(input.preparationId)
        || !isSha256(input.artifactHash)
        || !isSha256(input.beforeFingerprint)
        || !isSha256(input.afterFingerprint)
        || !isSha256(input.reportHash)
        || typeof input.committedAt !== "string" || !UTC_RE.test(input.committedAt)) {
        return failure("migration.invalidJournal", {reason: "invalid confirmed preparation input"});
    }
    const head = validateRelease(input.head);
    if (!head.ok) return head;
    const existing = await readConfirmedPreparation(session, checked.value, input.installationId, input.preparationId);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
        const one = existing.value;
        if (one.artifactHash !== input.artifactHash
            || one.head.releaseHash !== input.head.releaseHash
            || one.beforeFingerprint !== input.beforeFingerprint
            || one.afterFingerprint !== input.afterFingerprint
            || one.reportHash !== input.reportHash) {
            return failure("migration.invalidJournal", {reason: "preparation id already confirmed with different identity"});
        }
        return {ok: true, value: one};
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.preparations`;
    const result = await safeQuery(session, `INSERT INTO ${table} (
        installation_id, ordinal, preparation_id, artifact_hash,
        head_system_id, head_release_id, head_release_hash,
        before_fingerprint, after_fingerprint, report_hash, committed_at
    ) VALUES (
        $1,
        COALESCE((SELECT MAX(p.ordinal)+1 FROM ${table} p WHERE p.installation_id=$1),1),
        $2,$3,$4,$5,$6,$7,$8,$9,$10
    ) RETURNING ${preparationSelect("preparations")}`, [
        input.installationId,
        input.preparationId,
        input.artifactHash,
        input.head.systemId,
        input.head.releaseId,
        input.head.releaseHash,
        input.beforeFingerprint,
        input.afterFingerprint,
        input.reportHash,
        input.committedAt,
    ]);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) return failure("migration.invalidJournal", {reason: "confirmed preparation insert failed"});
    return decodePreparationRow(result.value.rows[0]);
}

export async function readPreparationHistory(
    session: PgSession,
    config: JournalConfig,
    installationId: string,
): Promise<ValidationResult<readonly PreparationHistoryInfo[]>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(installationId)) return failure("migration.invalidJournal", {reason: "invalid installation id"});
    const table = `${quotePgIdentifier(checked.value.schema)}.preparations`;
    const result = await safeQuery(session, `SELECT ${preparationSelect("preparations")}
        FROM ${table} preparations WHERE installation_id=$1 ORDER BY ordinal`, [installationId]);
    if (!result.ok) return result;
    const history: PreparationHistoryInfo[] = [];
    for (const row of result.value.rows) {
        const decoded = decodePreparationRow(row);
        if (!decoded.ok) return decoded;
        history.push(decoded.value);
    }
    for (let index = 0; index < history.length; index++) {
        if (history[index]!.ordinal !== index + 1) {
            return failure("migration.invalidJournal", {reason: "preparation history ordinals are not contiguous"});
        }
    }
    return {ok: true, value: history};
}

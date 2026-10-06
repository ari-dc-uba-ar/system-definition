import {
    isPlainObject,
    isSha256,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    JOURNAL_FORMAT_VERSION,
    UTC_RE,
    canonicalSchemas,
    decodeProblems,
    decodeReleaseParts,
    failure,
    isAttemptState,
    isFinishedAttemptState,
    journalShape,
    positiveInteger,
    queryFailure,
    safeQuery,
    sameRelease,
    sqlAttemptState,
    sqlAttemptStates,
    validateConfig,
    validateConfigForScope,
    validateRelease,
    validateScope,
    type Row,
} from "./journal-internal";

export * from "./journal-contracts";

import {
    ATTEMPT_STATE,
    ATTEMPT_STATES,
    type AttemptFinishInput,
    type AttemptInfo,
    type AttemptStartInput,
    type AttemptState,
    type InstallationInfo,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
    type PgSessionFactory,
    type PreparationAttemptFinishInput,
    type PreparationAttemptInfo,
    type PreparationAttemptStartInput,
    type PreparationAttemptState,
    type PreparationHistoryInfo,
} from "./journal-contracts";

function decodeInstallationRow(value: unknown): ValidationResult<InstallationInfo> {
    const keys = [
        "installation_id",
        "system_id",
        "schemas",
        "baseline_system_id",
        "baseline_release_id",
        "baseline_release_hash",
        "current_system_id",
        "current_release_id",
        "current_release_hash",
        "journal_format_version",
    ] as const;
    if (!isPlainObject(value)) return failure("migration.invalidJournal", {reason: "invalid installation row"});
    const shape = journalShape(value, keys, "invalid installation row");
    if (!shape.ok) return shape;
    if (!isPgNonEmptyText(value.installation_id)
        || !isPgNonEmptyText(value.system_id)
        || value.journal_format_version !== JOURNAL_FORMAT_VERSION
        || !Array.isArray(value.schemas)) {
        return failure("migration.invalidJournal", {reason: "invalid installation row values"});
    }
    const schemas = canonicalSchemas(value.schemas as readonly string[]);
    if (!schemas.ok) return schemas;
    const baseline = decodeReleaseParts(
        value.baseline_system_id,
        value.baseline_release_id,
        value.baseline_release_hash,
    );
    if (!baseline.ok) return baseline;
    const current = decodeReleaseParts(
        value.current_system_id,
        value.current_release_id,
        value.current_release_hash,
    );
    if (!current.ok) return current;
    if (baseline.value.systemId !== value.system_id || current.value.systemId !== value.system_id) {
        return failure("migration.invalidJournal", {reason: "installation release system does not match installation system"});
    }
    return {
        ok: true,
        value: {
            installationId: value.installation_id,
            systemId: value.system_id,
            schemas: schemas.value,
            baseline: baseline.value,
            current: current.value,
            journalFormatVersion: JOURNAL_FORMAT_VERSION,
        },
    };
}

function decodeHistoryRow(value: unknown): ValidationResult<MigrationHistoryInfo> {
    const keys = [
        "installation_id",
        "ordinal",
        "migration_id",
        "migration_hash",
        "from_system_id",
        "from_release_id",
        "from_release_hash",
        "to_system_id",
        "to_release_id",
        "to_release_hash",
        "committed_at",
    ] as const;
    if (!isPlainObject(value)) return failure("migration.invalidJournal", {reason: "invalid migration history row"});
    const shape = journalShape(value, keys, "invalid migration history row");
    if (!shape.ok) return shape;
    if (!isPgNonEmptyText(value.installation_id)
        || !positiveInteger(value.ordinal)
        || !isPgNonEmptyText(value.migration_id)
        || !isSha256(value.migration_hash)
        || typeof value.committed_at !== "string"
        || !UTC_RE.test(value.committed_at)) {
        return failure("migration.invalidJournal", {reason: "invalid migration history row"});
    }
    const from = decodeReleaseParts(value.from_system_id, value.from_release_id, value.from_release_hash);
    if (!from.ok) return from;
    const to = decodeReleaseParts(value.to_system_id, value.to_release_id, value.to_release_hash);
    if (!to.ok) return to;
    if (from.value.systemId !== to.value.systemId) {
        return failure("migration.invalidJournal", {reason: "cross-system migration history"});
    }
    return {
        ok: true,
        value: {
            installationId: value.installation_id,
            ordinal: value.ordinal,
            migrationId: value.migration_id,
            migrationHash: value.migration_hash,
            from: from.value,
            to: to.value,
            committedAt: value.committed_at,
        },
    };
}

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

function installationSelect(alias = "i"): string {
    return [
        `${alias}.installation_id`,
        `${alias}.system_id`,
        `${alias}.schemas`,
        `${alias}.baseline_system_id`,
        `${alias}.baseline_release_id`,
        `${alias}.baseline_release_hash`,
        `${alias}.current_system_id`,
        `${alias}.current_release_id`,
        `${alias}.current_release_hash`,
        `${alias}.journal_format_version`,
    ].join(", ");
}

function historySelect(alias = "h"): string {
    return [
        `${alias}.installation_id`,
        `${alias}.ordinal`,
        `${alias}.migration_id`,
        `${alias}.migration_hash`,
        `${alias}.from_system_id`,
        `${alias}.from_release_id`,
        `${alias}.from_release_hash`,
        `${alias}.to_system_id`,
        `${alias}.to_release_id`,
        `${alias}.to_release_hash`,
        `${alias}.committed_at`,
    ].join(", ");
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

export {bootstrapJournal} from "./journal-schema";

export async function installBaseline(
    session: PgSession,
    config: JournalConfig,
    input: {installationId: string; scope: InstallationScope; baseline: ReleaseRefInfo},
): Promise<ValidationResult<InstallationInfo>> {
    if (!isPlainObject(input)) return failure("migration.invalidJournal", {reason: "invalid baseline installation input"});
    const inputShape = journalShape(input, ["installationId", "scope", "baseline"], "invalid baseline installation input");
    if (!inputShape.ok) return inputShape;
    if (!isPgNonEmptyText(input.installationId)) {
        return failure("migration.invalidJournal", {reason: "invalid baseline installation input"});
    }
    const checked = validateConfigForScope(config, input.scope);
    if (!checked.ok) return checked;
    const baseline = validateRelease(input.baseline);
    if (!baseline.ok) return baseline;
    if (baseline.value.systemId !== checked.value.scope.systemId) {
        return failure("migration.invalidJournal", {reason: "baseline system does not match installation scope"});
    }
    const table = `${quotePgIdentifier(checked.value.config.schema)}.installation`;
    const text = `INSERT INTO ${table} (
        installation_id, system_id, schemas,
        baseline_system_id, baseline_release_id, baseline_release_hash,
        current_system_id, current_release_id, current_release_hash,
        journal_format_version
    ) VALUES ($1,$2,ARRAY(SELECT jsonb_array_elements_text($3::jsonb)),$4,$5,$6,$7,$8,$9,1)
    RETURNING ${installationSelect("installation")}`;
    const values: readonly SqlParameter[] = [
        input.installationId,
        checked.value.scope.systemId,
        JSON.stringify(checked.value.scope.schemas),
        baseline.value.systemId,
        baseline.value.releaseId,
        baseline.value.releaseHash,
        baseline.value.systemId,
        baseline.value.releaseId,
        baseline.value.releaseHash,
    ];
    const result = await safeQuery(session, text, values);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) {
        return failure("migration.invalidJournal", {reason: "baseline insert did not return exactly one installation"});
    }
    return decodeInstallationRow(result.value.rows[0]);
}

export async function readInstallation(
    session: PgSession,
    config: JournalConfig,
    scope: InstallationScope,
): Promise<ValidationResult<InstallationInfo | null>> {
    const checked = validateConfigForScope(config, scope);
    if (!checked.ok) return checked;
    const table = `${quotePgIdentifier(checked.value.config.schema)}.installation`;
    const text = `SELECT ${installationSelect("i")} FROM ${table} i
        WHERE i.system_id = $1 AND i.schemas = ARRAY(SELECT jsonb_array_elements_text($2::jsonb))`;
    const result = await safeQuery(session, text, [
        checked.value.scope.systemId,
        JSON.stringify(checked.value.scope.schemas),
    ]);
    if (!result.ok) return result;
    if (result.value.rows.length === 0) return {ok: true, value: null};
    if (result.value.rows.length !== 1) {
        return failure("migration.invalidJournal", {reason: "installation scope is not unique"});
    }
    const decoded = decodeInstallationRow(result.value.rows[0]);
    if (!decoded.ok) return decoded;
    if (decoded.value.systemId !== checked.value.scope.systemId
        || decoded.value.schemas.length !== checked.value.scope.schemas.length
        || decoded.value.schemas.some((one, index) => one !== checked.value.scope.schemas[index])) {
        return failure("migration.invalidJournal", {reason: "installation scope mismatch"});
    }
    return decoded;
}

export async function readHistory(
    session: PgSession,
    config: JournalConfig,
    installationId: string,
): Promise<ValidationResult<readonly MigrationHistoryInfo[]>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(installationId)) {
        return failure("migration.invalidJournal", {reason: "invalid installation id"});
    }
    const table = `${quotePgIdentifier(checked.value.schema)}.migration_history`;
    const text = `SELECT ${historySelect("h")} FROM ${table} h
        WHERE h.installation_id = $1 ORDER BY h.ordinal`;
    const result = await safeQuery(session, text, [installationId]);
    if (!result.ok) return result;
    const history: MigrationHistoryInfo[] = [];
    for (const row of result.value.rows) {
        const decoded = decodeHistoryRow(row);
        if (!decoded.ok) return decoded;
        history.push(decoded.value);
    }
    return {ok: true, value: history};
}

export function verifyHistory(
    installation: InstallationInfo,
    history: readonly MigrationHistoryInfo[],
): ValidationResult<readonly MigrationHistoryInfo[]> {
    const decodedInstallation = decodeInstallationRow({
        installation_id: installation.installationId,
        system_id: installation.systemId,
        schemas: [...installation.schemas],
        baseline_system_id: installation.baseline.systemId,
        baseline_release_id: installation.baseline.releaseId,
        baseline_release_hash: installation.baseline.releaseHash,
        current_system_id: installation.current.systemId,
        current_release_id: installation.current.releaseId,
        current_release_hash: installation.current.releaseHash,
        journal_format_version: installation.journalFormatVersion,
    });
    if (!decodedInstallation.ok) return decodedInstallation;
    if (!Array.isArray(history)) return failure("migration.invalidJournal", {reason: "invalid migration history"});

    let expectedFrom = decodedInstallation.value.baseline;
    const result: MigrationHistoryInfo[] = [];
    for (let index = 0; index < history.length; index++) {
        const one = history[index];
        const decoded = decodeHistoryRow({
            installation_id: one.installationId,
            ordinal: one.ordinal,
            migration_id: one.migrationId,
            migration_hash: one.migrationHash,
            from_system_id: one.from.systemId,
            from_release_id: one.from.releaseId,
            from_release_hash: one.from.releaseHash,
            to_system_id: one.to.systemId,
            to_release_id: one.to.releaseId,
            to_release_hash: one.to.releaseHash,
            committed_at: one.committedAt,
        });
        if (!decoded.ok) return decoded;
        if (decoded.value.installationId !== decodedInstallation.value.installationId
            || decoded.value.ordinal !== index + 1
            || !sameRelease(decoded.value.from, expectedFrom)
            || decoded.value.from.systemId !== decodedInstallation.value.systemId) {
            return failure("migration.invalidJournal", {reason: "migration history is not contiguous from baseline"});
        }
        expectedFrom = decoded.value.to;
        result.push(decoded.value);
    }
    if (!sameRelease(expectedFrom, decodedInstallation.value.current)) {
        return failure("migration.invalidJournal", {reason: "migration history does not end at installation head"});
    }
    return {ok: true, value: result};
}

export async function appendCommittedMigration(
    session: PgSession,
    config: JournalConfig,
    expectedHead: ReleaseRefInfo,
    history: MigrationHistoryInfo,
): Promise<ValidationResult<InstallationInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    const expected = validateRelease(expectedHead);
    if (!expected.ok) return expected;
    const decodedHistory = decodeHistoryRow({
        installation_id: history.installationId,
        ordinal: history.ordinal,
        migration_id: history.migrationId,
        migration_hash: history.migrationHash,
        from_system_id: history.from.systemId,
        from_release_id: history.from.releaseId,
        from_release_hash: history.from.releaseHash,
        to_system_id: history.to.systemId,
        to_release_id: history.to.releaseId,
        to_release_hash: history.to.releaseHash,
        committed_at: history.committedAt,
    });
    if (!decodedHistory.ok) return decodedHistory;
    if (!sameRelease(decodedHistory.value.from, expected.value)) {
        return failure("migration.invalidJournal", {reason: "migration origin does not match expected head"});
    }

    const schema = quotePgIdentifier(checked.value.schema);
    const text = `WITH current_installation AS (
        SELECT i.installation_id
        FROM ${schema}.installation i
        WHERE i.installation_id = $1
          AND i.current_system_id = $2
          AND i.current_release_id = $3
          AND i.current_release_hash = $4
        FOR UPDATE
    ), inserted_history AS (
        INSERT INTO ${schema}.migration_history (
            installation_id, ordinal, migration_id, migration_hash,
            from_system_id, from_release_id, from_release_hash,
            to_system_id, to_release_id, to_release_hash, committed_at
        )
        SELECT $1,$5,$6,$7,$2,$3,$4,$8,$9,$10,$11
        FROM current_installation
        WHERE $5 = COALESCE((SELECT MAX(h.ordinal) + 1 FROM ${schema}.migration_history h WHERE h.installation_id = $1), 1)
        RETURNING installation_id
    ), updated_installation AS (
        UPDATE ${schema}.installation i
        SET current_system_id = $8,
            current_release_id = $9,
            current_release_hash = $10
        FROM inserted_history h
        WHERE i.installation_id = h.installation_id
        RETURNING i.*
    )
    SELECT ${installationSelect("u")} FROM updated_installation u`;
    const values: readonly SqlParameter[] = [
        decodedHistory.value.installationId,
        expected.value.systemId,
        expected.value.releaseId,
        expected.value.releaseHash,
        decodedHistory.value.ordinal,
        decodedHistory.value.migrationId,
        decodedHistory.value.migrationHash,
        decodedHistory.value.to.systemId,
        decodedHistory.value.to.releaseId,
        decodedHistory.value.to.releaseHash,
        decodedHistory.value.committedAt,
    ];
    const result = await safeQuery(session, text, values);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) {
        return failure("migration.headMismatch", {reason: "history/head update did not affect exactly one installation"});
    }
    const installation = decodeInstallationRow(result.value.rows[0]);
    if (!installation.ok) return installation;
    if (!sameRelease(installation.value.current, decodedHistory.value.to)) {
        return failure("migration.invalidJournal", {reason: "journal head does not match committed migration target"});
    }
    return installation;
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

function lockScopeKey(scope: InstallationScope): string {
    return JSON.stringify({systemId: scope.systemId, schemas: [...scope.schemas].sort()});
}

function booleanField(row: unknown, key: string): boolean | null {
    if (!isPlainObject(row) || typeof row[key] !== "boolean") return null;
    return row[key];
}

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}


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

export async function withMigrationLock<T>(
    factory: PgSessionFactory,
    scope: InstallationScope,
    lockWaitTimeoutMs: number,
    work: (session: PgSession) => Promise<ValidationResult<T>>,
): Promise<ValidationResult<T>> {
    const checkedScope = validateScope(scope);
    if (!checkedScope.ok) return checkedScope;
    if (!Number.isFinite(lockWaitTimeoutMs) || !Number.isInteger(lockWaitTimeoutMs) || lockWaitTimeoutMs <= 0) {
        return failure("migration.invalidExecutionOptions", {field: "lockWaitTimeoutMs"});
    }
    if (factory === null || typeof factory !== "object" || typeof factory.openTarget !== "function" || typeof work !== "function") {
        return failure("migration.invalidJournal", {reason: "invalid migration lock arguments"});
    }

    let session: PgSession;
    try {
        session = await factory.openTarget();
    } catch (error) {
        return queryFailure(error);
    }

    const key = lockScopeKey(checkedScope.value);
    const lockSql = `SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || $1, 0)) AS locked`;
    const unlockSql = `SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || $1, 0)) AS unlocked`;
    let acquired = false;
    let result: ValidationResult<T> | null = null;
    const deadline = Date.now() + lockWaitTimeoutMs;

    try {
        while (true) {
            const locked = await safeQuery(session, lockSql, [key]);
            if (!locked.ok) {
                result = locked;
                break;
            }
            const value = locked.value.rows.length === 1 ? booleanField(locked.value.rows[0], "locked") : null;
            if (value === null) {
                result = failure("migration.invalidJournal", {reason: "invalid advisory lock response"});
                break;
            }
            if (value) {
                acquired = true;
                try {
                    result = await work(session);
                } catch (error) {
                    result = failure("migration.executionFailed", {
                        reason: error instanceof Error ? error.message : "migration work threw",
                    });
                }
                break;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                result = failure("migration.lockTimeout", {scope: key});
                break;
            }
            await wait(Math.min(25, remaining));
        }
    } finally {
        if (acquired) {
            try {
                await session.query(unlockSql, [key]);
            } catch {
                if (result?.ok !== false) {
                    result = failure("migration.journalQueryFailed", {reason: "could not release advisory lock explicitly"});
                }
            }
        }
        try {
            await session.close();
        } catch {
            if (result?.ok !== false) {
                result = failure("migration.journalQueryFailed", {reason: "could not close dedicated lock session"});
            }
        }
    }

    return result ?? failure("migration.executionFailed", {reason: "migration lock execution did not produce a result"});
}

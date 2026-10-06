import {
    problem,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";

export type JournalConfig = {
    schema: string;
};

export type InstallationScope = {
    systemId: string;
    schemas: readonly string[];
};

export type InstallationInfo = {
    installationId: string;
    systemId: string;
    schemas: readonly string[];
    baseline: ReleaseRefInfo;
    current: ReleaseRefInfo;
    journalFormatVersion: 1;
};

export type MigrationHistoryInfo = {
    installationId: string;
    ordinal: number;
    migrationId: string;
    migrationHash: string;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    committedAt: string;
};

export const ATTEMPT_STATE = {
    running: "running",
    failed: "failed",
    unknown: "unknown",
    succeeded: "succeeded",
} as const;

export const ATTEMPT_STATES = [
    ATTEMPT_STATE.running,
    ATTEMPT_STATE.failed,
    ATTEMPT_STATE.unknown,
    ATTEMPT_STATE.succeeded,
] as const;

export type AttemptState = typeof ATTEMPT_STATES[number];

export type AttemptInfo = {
    attemptId: string;
    deploymentId: string;
    installationId: string;
    planHash: string;
    state: AttemptState;
    confirmedTarget: ReleaseRefInfo | null;
    problems: readonly Problem[];
};

export type AttemptStartInput = {
    attemptId: string;
    deploymentId: string;
    installationId: string;
    planHash: string;
};

export type AttemptFinishInput = {
    state: Exclude<AttemptState, "running">;
    confirmedTarget: ReleaseRefInfo | null;
    problems: readonly Problem[];
};

export type PreparationAttemptState = AttemptState;

export type PreparationAttemptInfo = {
    attemptId: string;
    installationId: string;
    preparationId: string;
    artifactHash: string;
    state: PreparationAttemptState;
    beforeFingerprint: string;
    afterFingerprint: string | null;
    reportHash: string;
    problems: readonly Problem[];
};

export type PreparationHistoryInfo = {
    installationId: string;
    ordinal: number;
    preparationId: string;
    artifactHash: string;
    head: ReleaseRefInfo;
    beforeFingerprint: string;
    afterFingerprint: string;
    reportHash: string;
    committedAt: string;
};

export type PreparationAttemptStartInput = {
    attemptId: string;
    installationId: string;
    preparationId: string;
    artifactHash: string;
    beforeFingerprint: string;
    reportHash: string;
};

export type PreparationAttemptFinishInput = {
    state: Exclude<PreparationAttemptState, "running">;
    afterFingerprint: string | null;
    problems: readonly Problem[];
};

export interface PgSessionFactory {
    openTarget(): Promise<PgSession>;
}

type QueryResult = Awaited<ReturnType<PgSession["query"]>>;
type Row = Readonly<Record<string, unknown>>;

const JOURNAL_FORMAT_VERSION = 1 as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const ATTEMPT_STATE_SET = new Set<string>(ATTEMPT_STATES);

function isAttemptState(value: unknown): value is AttemptState {
    return typeof value === "string" && ATTEMPT_STATE_SET.has(value);
}

function isFinishedAttemptState(value: unknown): value is Exclude<AttemptState, "running"> {
    return isAttemptState(value) && value !== ATTEMPT_STATE.running;
}

function sqlAttemptState(state: AttemptState): string {
    return "'" + state.replaceAll("'", "''") + "'";
}

function sqlAttemptStates(states: readonly AttemptState[]): string {
    return states.map(sqlAttemptState).join(",");
}

function failure<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function queryFailure<T>(error: unknown): ValidationResult<T> {
    return failure("migration.journalQueryFailed", {
        reason: error instanceof Error ? error.message : "journal query failed",
    });
}

function isPlainObject(value: unknown): value is Row {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(row: Row, expected: readonly string[]): boolean {
    const actual = Object.keys(row).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function hashString(value: unknown): value is string {
    return typeof value === "string" && HASH_RE.test(value);
}

function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function decodeReleaseParts(
    systemId: unknown,
    releaseId: unknown,
    releaseHash: unknown,
): ValidationResult<ReleaseRefInfo> {
    if (!nonEmptyString(systemId) || !nonEmptyString(releaseId) || !hashString(releaseHash)) {
        return failure("migration.invalidJournal", {reason: "invalid release reference"});
    }
    return {ok: true, value: {systemId, releaseId, releaseHash}};
}

function validateRelease(value: ReleaseRefInfo): ValidationResult<ReleaseRefInfo> {
    return decodeReleaseParts(value.systemId, value.releaseId, value.releaseHash);
}

function sameRelease(left: ReleaseRefInfo, right: ReleaseRefInfo): boolean {
    return left.systemId === right.systemId
        && left.releaseId === right.releaseId
        && left.releaseHash === right.releaseHash;
}

function canonicalSchemas(schemas: readonly string[]): ValidationResult<readonly string[]> {
    if (!Array.isArray(schemas) || schemas.length === 0) {
        return failure("migration.invalidJournal", {reason: "installation scope must contain at least one schema"});
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const schema of schemas) {
        if (!nonEmptyString(schema)) {
            return failure("migration.invalidJournal", {reason: "invalid application schema"});
        }
        if (seen.has(schema)) {
            return failure("migration.invalidJournal", {reason: "duplicate application schema", schema});
        }
        seen.add(schema);
        result.push(schema);
    }
    result.sort();
    return {ok: true, value: result};
}

function validateScope(scope: InstallationScope): ValidationResult<InstallationScope> {
    if (!isPlainObject(scope) || !hasExactKeys(scope, ["systemId", "schemas"])) {
        return failure("migration.invalidJournal", {reason: "invalid installation scope"});
    }
    if (!nonEmptyString(scope.systemId)) {
        return failure("migration.invalidJournal", {reason: "invalid system id"});
    }
    const schemas = canonicalSchemas(scope.schemas);
    if (!schemas.ok) return schemas;
    return {ok: true, value: {systemId: scope.systemId, schemas: schemas.value}};
}

function validateConfig(config: JournalConfig): ValidationResult<JournalConfig> {
    if (!isPlainObject(config) || !hasExactKeys(config, ["schema"]) || !nonEmptyString(config.schema)) {
        return failure("migration.invalidJournal", {reason: "invalid journal schema"});
    }
    return {ok: true, value: {schema: config.schema}};
}

function validateConfigForScope(
    config: JournalConfig,
    scope: InstallationScope,
): ValidationResult<{config: JournalConfig; scope: InstallationScope}> {
    const checkedConfig = validateConfig(config);
    if (!checkedConfig.ok) return checkedConfig;
    const checkedScope = validateScope(scope);
    if (!checkedScope.ok) return checkedScope;
    if (checkedScope.value.schemas.includes(checkedConfig.value.schema)) {
        return failure("migration.invalidJournal", {
            reason: "journal schema must be separate from managed application schemas",
            schema: checkedConfig.value.schema,
        });
    }
    return {ok: true, value: {config: checkedConfig.value, scope: checkedScope.value}};
}

function decodeProblem(value: unknown): ValidationResult<Problem> {
    if (!isPlainObject(value)
        || !hasExactKeys(value, ["field", "messageKey", "severity", "details"])
        || !(value.field === null || typeof value.field === "string")
        || !nonEmptyString(value.messageKey)
        || !(value.severity === "blocking" || value.severity === "regular")
        || !isPlainObject(value.details)) {
        return failure("migration.invalidJournal", {reason: "invalid attempt problem"});
    }
    const details: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, detail] of Object.entries(value.details)) {
        if (typeof detail !== "string") {
            return failure("migration.invalidJournal", {reason: "problem details must be strings"});
        }
        details[key] = detail;
    }
    return {
        ok: true,
        value: {
            field: value.field,
            messageKey: value.messageKey,
            severity: value.severity,
            details,
        },
    };
}

function decodeProblems(value: unknown): ValidationResult<readonly Problem[]> {
    if (!Array.isArray(value)) return failure("migration.invalidJournal", {reason: "invalid attempt problems"});
    const result: Problem[] = [];
    for (const one of value) {
        const decoded = decodeProblem(one);
        if (!decoded.ok) return decoded;
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

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
    if (!isPlainObject(value) || !hasExactKeys(value, keys)) {
        return failure("migration.invalidJournal", {reason: "invalid installation row"});
    }
    if (!nonEmptyString(value.installation_id)
        || !nonEmptyString(value.system_id)
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
    if (!isPlainObject(value) || !hasExactKeys(value, keys)
        || !nonEmptyString(value.installation_id)
        || !positiveInteger(value.ordinal)
        || !nonEmptyString(value.migration_id)
        || !hashString(value.migration_hash)
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
    if (!isPlainObject(value) || !hasExactKeys(value, keys)
        || !nonEmptyString(value.attempt_id)
        || !nonEmptyString(value.deployment_id)
        || !nonEmptyString(value.installation_id)
        || !hashString(value.plan_hash)
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

async function safeQuery(
    session: PgSession,
    text: string,
    values: readonly SqlParameter[],
): Promise<ValidationResult<QueryResult>> {
    try {
        return {ok: true, value: await session.query(text, values)};
    } catch (error) {
        return queryFailure(error);
    }
}

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

export async function installBaseline(
    session: PgSession,
    config: JournalConfig,
    input: {installationId: string; scope: InstallationScope; baseline: ReleaseRefInfo},
): Promise<ValidationResult<InstallationInfo>> {
    if (!isPlainObject(input) || !hasExactKeys(input, ["installationId", "scope", "baseline"])
        || !nonEmptyString(input.installationId)) {
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
    if (!nonEmptyString(installationId)) {
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
    if (!isPlainObject(input)
        || !hasExactKeys(input, ["attemptId", "deploymentId", "installationId", "planHash"])
        || !nonEmptyString(input.attemptId)
        || !nonEmptyString(input.deploymentId)
        || !nonEmptyString(input.installationId)
        || !hashString(input.planHash)) {
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
    if (!nonEmptyString(attemptId)
        || !isPlainObject(resultInput)
        || !hasExactKeys(resultInput, ["state", "confirmedTarget", "problems"])
        || !isFinishedAttemptState(resultInput.state)) {
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


function validPreparationHash(value: unknown): value is string {
    return typeof value === "string" && HASH_RE.test(value);
}

function preparationAttemptSelect(alias: string): string {
    return `${alias}.attempt_id, ${alias}.installation_id, ${alias}.preparation_id, ${alias}.artifact_hash,
        ${alias}.state, ${alias}.before_fingerprint, ${alias}.after_fingerprint, ${alias}.report_hash, ${alias}.problems`;
}

function decodePreparationAttemptRow(value: unknown): ValidationResult<PreparationAttemptInfo> {
    if (!isPlainObject(value)
        || !nonEmptyString(value.attempt_id)
        || !nonEmptyString(value.installation_id)
        || !nonEmptyString(value.preparation_id)
        || !validPreparationHash(value.artifact_hash)
        || !isAttemptState(value.state)
        || !validPreparationHash(value.before_fingerprint)
        || !(value.after_fingerprint === null || validPreparationHash(value.after_fingerprint))
        || !validPreparationHash(value.report_hash)) {
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
        || !nonEmptyString(value.installation_id)
        || !positiveInteger(value.ordinal)
        || !nonEmptyString(value.preparation_id)
        || !validPreparationHash(value.artifact_hash)
        || !nonEmptyString(value.head_system_id)
        || !nonEmptyString(value.head_release_id)
        || !validPreparationHash(value.head_release_hash)
        || !validPreparationHash(value.before_fingerprint)
        || !validPreparationHash(value.after_fingerprint)
        || !validPreparationHash(value.report_hash)
        || typeof value.committed_at !== "string" || !UTC_RE.test(value.committed_at)) {
        return failure("migration.invalidJournal", {reason: "invalid confirmed preparation row"});
    }
    return {
        ok: true,
        value: {
            installationId: value.installation_id,
            ordinal: value.ordinal,
            preparationId: value.preparation_id,
            artifactHash: value.artifact_hash,
            head: {
                systemId: value.head_system_id,
                releaseId: value.head_release_id,
                releaseHash: value.head_release_hash,
            },
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
        || !nonEmptyString(input.attemptId)
        || !nonEmptyString(input.installationId)
        || !nonEmptyString(input.preparationId)
        || !validPreparationHash(input.artifactHash)
        || !validPreparationHash(input.beforeFingerprint)
        || !validPreparationHash(input.reportHash)) {
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
    if (!nonEmptyString(attemptId)
        || !isPlainObject(input)
        || !isFinishedAttemptState(input.state)
        || !(input.afterFingerprint === null || validPreparationHash(input.afterFingerprint))
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
    if (!nonEmptyString(installationId) || !nonEmptyString(preparationId)) {
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
        || !nonEmptyString(input.installationId)
        || !nonEmptyString(input.preparationId)
        || !validPreparationHash(input.artifactHash)
        || !validPreparationHash(input.beforeFingerprint)
        || !validPreparationHash(input.afterFingerprint)
        || !validPreparationHash(input.reportHash)
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
    if (!nonEmptyString(installationId)) return failure("migration.invalidJournal", {reason: "invalid installation id"});
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

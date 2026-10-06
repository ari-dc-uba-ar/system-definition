import {
    isPlainObject,
    isSha256,
    sameReleaseRef,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import type {
    InstallationInfo,
    InstallationScope,
    JournalConfig,
    MigrationHistoryInfo,
} from "./journal-contracts";
import {
    JOURNAL_FORMAT_VERSION,
    UTC_RE,
    canonicalSchemas,
    decodeReleaseParts,
    failure,
    journalShape,
    positiveInteger,
    safeQuery,
    validateConfig,
    validateConfigForScope,
    validateRelease,
    type Row,
} from "./journal-internal";

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
            || !sameReleaseRef(decoded.value.from, expectedFrom)
            || decoded.value.from.systemId !== decodedInstallation.value.systemId) {
            return failure("migration.invalidJournal", {reason: "migration history is not contiguous from baseline"});
        }
        expectedFrom = decoded.value.to;
        result.push(decoded.value);
    }
    if (!sameReleaseRef(expectedFrom, decodedInstallation.value.current)) {
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
    if (!sameReleaseRef(decodedHistory.value.from, expected.value)) {
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
    if (!sameReleaseRef(installation.value.current, decodedHistory.value.to)) {
        return failure("migration.invalidJournal", {reason: "journal head does not match committed migration target"});
    }
    return installation;
}

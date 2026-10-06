import {isPlainObject, type ValidationResult} from "system-definition";
import {quotePgIdentifier, type PgSession, type SqlParameter} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";
import {
    VERIFICATION_STATUSES,
    type JournalConfig,
    type VerificationRecordInfo,
    type VerificationRecordInput,
    type VerificationStatus,
} from "./journal-contracts";
import {failure, journalShape, positiveInteger, safeQuery, validateConfig} from "./journal-internal";

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isVerificationStatus(value: unknown): value is VerificationStatus {
    return typeof value === "string" && VERIFICATION_STATUSES.includes(value as VerificationStatus);
}

function verificationSelect(alias = "v"): string {
    return [
        `${alias}.verification_id`,
        `${alias}.ordinal`,
        `${alias}.deployment_id`,
        `${alias}.binding`,
        `${alias}.status`,
        `${alias}.checks`,
        `${alias}.created_at`,
    ].join(", ");
}

function decodeVerificationRow(value: unknown): ValidationResult<VerificationRecordInfo> {
    if (!isPlainObject(value)) return failure("migration.invalidJournal", {reason: "invalid verification row"});
    const shape = journalShape(
        value,
        ["verification_id", "ordinal", "deployment_id", "binding", "status", "checks", "created_at"],
        "invalid verification row",
    );
    if (!shape.ok
        || !isPgNonEmptyText(value.verification_id)
        || !positiveInteger(value.ordinal)
        || !isPgNonEmptyText(value.deployment_id)
        || !isVerificationStatus(value.status)
        || typeof value.created_at !== "string"
        || !UTC_RE.test(value.created_at)) {
        return failure("migration.invalidJournal", {reason: "invalid verification row"});
    }
    return {
        ok: true,
        value: {
            verificationId: value.verification_id,
            ordinal: value.ordinal,
            deploymentId: value.deployment_id,
            binding: value.binding,
            status: value.status,
            checks: value.checks,
            createdAt: value.created_at,
        },
    };
}

export async function recordVerificationRecord(
    session: PgSession,
    config: JournalConfig,
    input: VerificationRecordInput,
): Promise<ValidationResult<VerificationRecordInfo>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(input.verificationId)
        || !isPgNonEmptyText(input.deploymentId)
        || !isVerificationStatus(input.status)
        || typeof input.createdAt !== "string"
        || !UTC_RE.test(input.createdAt)) {
        return failure("migration.invalidJournal", {reason: "invalid verification input"});
    }
    const schema = quotePgIdentifier(checked.value.schema);
    const text = `WITH deployment_lock AS (
        SELECT pg_advisory_xact_lock(hashtextextended('system-definition:verification:' || $1, 0))
    ), next_ordinal AS (
        SELECT COALESCE(MAX(v.ordinal), 0) + 1 AS ordinal
        FROM ${schema}.verification_run v
        CROSS JOIN deployment_lock
        WHERE v.deployment_id = $1
    )
    INSERT INTO ${schema}.verification_run (
        verification_id, deployment_id, ordinal, binding, status, checks, created_at
    )
    SELECT $2,$1,n.ordinal,$3::jsonb,$4,$5::jsonb,$6
    FROM next_ordinal n
    RETURNING ${verificationSelect("verification_run")}`;
    const values: readonly SqlParameter[] = [
        input.deploymentId,
        input.verificationId,
        JSON.stringify(input.binding),
        input.status,
        JSON.stringify(input.checks),
        input.createdAt,
    ];
    const result = await safeQuery(session, text, values);
    if (!result.ok) return result;
    if (result.value.rows.length !== 1) {
        return failure("migration.invalidJournal", {reason: "verification insert did not return exactly one row"});
    }
    return decodeVerificationRow(result.value.rows[0]);
}

export async function readLatestVerificationRecord(
    session: PgSession,
    config: JournalConfig,
    deploymentId: string,
): Promise<ValidationResult<VerificationRecordInfo | null>> {
    const checked = validateConfig(config);
    if (!checked.ok) return checked;
    if (!isPgNonEmptyText(deploymentId)) {
        return failure("migration.invalidJournal", {reason: "invalid verification lookup"});
    }
    const schema = quotePgIdentifier(checked.value.schema);
    const result = await safeQuery(session, `SELECT ${verificationSelect("v")}
        FROM ${schema}.verification_run v
        WHERE v.deployment_id = $1
        ORDER BY v.ordinal DESC
        LIMIT 1`, [deploymentId]);
    if (!result.ok) return result;
    if (result.value.rows.length === 0) return {ok: true, value: null};
    if (result.value.rows.length !== 1) {
        return failure("migration.invalidJournal", {reason: "latest verification lookup is not unique"});
    }
    const decoded = decodeVerificationRow(result.value.rows[0]);
    if (!decoded.ok) return decoded;
    if (decoded.value.deploymentId !== deploymentId) {
        return failure("migration.invalidJournal", {reason: "verification does not match lookup"});
    }
    return decoded;
}

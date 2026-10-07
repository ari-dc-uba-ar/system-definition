import {
    decodeProblem as decodeProblemInfo,
    decodeReleaseRefInfo,
    exactKeys,
    isPlainObject,
    isSha256,
    problem,
    sameOptionalReleaseRef,
    sameReleaseRef,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    readLatestVerificationRecord,
    recordVerificationRecord,
    validateJournalConfig,
    type JournalConfig,
    type VerificationRecordInfo,
} from "./journal";
import {
    VERIFICATION_STATUS,
    VERIFICATION_STATUSES,
    type VerificationStatus,
} from "./journal-contracts";
import {POSTGRES_SUPPORT} from "./postgres-support";
import type {PgSession} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";

export type DeploymentBindingBase = {
    deploymentId: string;
    installationId: string;
    candidateApplicationHash: string;
    planHash: string;
    to: ReleaseRefInfo;
    engineVersion: typeof POSTGRES_SUPPORT.version;
    schemas: readonly string[];
    configurationHash: string;
    maintenanceId: string;
    production: boolean;
};

export type DeploymentBindingInfo = DeploymentBindingBase & (
    | {operation: "install"; from: null}
    | {operation: "upgrade"; from: ReleaseRefInfo}
);

export type VerificationCheckInfo = {
    id: string;
    kind: "artifacts" | "environment" | "structure" | "data" | "rehearsal";
    status: VerificationStatus;
    reportId: string;
    problems: readonly Problem[];
};

export type VerificationRunInfo = {
    verificationId: string;
    ordinal: number;
    binding: DeploymentBindingInfo;
    status: VerificationStatus;
    checks: readonly VerificationCheckInfo[];
    createdAt: string;
};

export type VerificationRunDraft = Omit<VerificationRunInfo, "ordinal" | "status">;

export type EvidenceContext = {
    session: PgSession;
    journal: JournalConfig;
};

type VerificationKind = VerificationCheckInfo["kind"];

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CHECK_KINDS: readonly VerificationKind[] = [
    "artifacts",
    "environment",
    "structure",
    "data",
    "rehearsal",
];

function failure<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function decodeRelease(value: unknown): ValidationResult<ReleaseRefInfo> {
    const decoded = decodeReleaseRefInfo(
        value,
        "$",
        () => failure("deployment.evidenceMismatch", {reason: "invalid release reference"}),
    );
    if (!decoded.ok) return decoded;
    if (!isPgNonEmptyText(decoded.value.systemId) || !isPgNonEmptyText(decoded.value.releaseId)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid release reference"});
    }
    return decoded;
}

function decodeSchemas(value: unknown): ValidationResult<readonly string[]> {
    if (!Array.isArray(value) || value.length === 0) {
        return failure("deployment.evidenceMismatch", {reason: "invalid deployment schemas"});
    }
    const schemas: string[] = [];
    const seen = new Set<string>();
    for (const schema of value) {
        if (!isPgNonEmptyText(schema) || seen.has(schema)) {
            return failure("deployment.evidenceMismatch", {reason: "invalid deployment schemas"});
        }
        seen.add(schema);
        schemas.push(schema);
    }
    return {ok: true, value: schemas};
}

function decodeBinding(value: unknown): ValidationResult<DeploymentBindingInfo> {
    if (!isPlainObject(value)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid deployment binding"});
    }
    const commonKeys = [
        "deploymentId",
        "installationId",
        "candidateApplicationHash",
        "planHash",
        "operation",
        "from",
        "to",
        "engineVersion",
        "schemas",
        "configurationHash",
        "maintenanceId",
        "production",
    ] as const;
    const shape = exactKeys(value, commonKeys, "$", () => failure("deployment.evidenceMismatch", {reason: "invalid deployment binding"}));
    if (!shape.ok
        || !isPgNonEmptyText(value.deploymentId)
        || !isPgNonEmptyText(value.installationId)
        || !isSha256(value.candidateApplicationHash)
        || !isSha256(value.planHash)
        || !isSha256(value.configurationHash)
        || !isPgNonEmptyText(value.maintenanceId)
        || value.engineVersion !== POSTGRES_SUPPORT.version
        || typeof value.production !== "boolean"
        || !(value.operation === "install" || value.operation === "upgrade")) {
        return failure("deployment.evidenceMismatch", {reason: "invalid deployment binding"});
    }
    const schemas = decodeSchemas(value.schemas);
    if (!schemas.ok) return schemas;
    const to = decodeRelease(value.to);
    if (!to.ok) return to;

    if (value.operation === "install") {
        if (value.from !== null) {
            return failure("deployment.evidenceMismatch", {reason: "install binding must have null origin"});
        }
        return {
            ok: true,
            value: {
                deploymentId: value.deploymentId,
                installationId: value.installationId,
                candidateApplicationHash: value.candidateApplicationHash,
                planHash: value.planHash,
                operation: "install",
                from: null,
                to: to.value,
                engineVersion: POSTGRES_SUPPORT.version,
                schemas: schemas.value,
                configurationHash: value.configurationHash,
                maintenanceId: value.maintenanceId,
                production: value.production,
            },
        };
    }

    const from = decodeRelease(value.from);
    if (!from.ok) return from;
    if (from.value.systemId !== to.value.systemId) {
        return failure("deployment.evidenceMismatch", {reason: "upgrade binding crosses systems"});
    }
    return {
        ok: true,
        value: {
            deploymentId: value.deploymentId,
            installationId: value.installationId,
            candidateApplicationHash: value.candidateApplicationHash,
            planHash: value.planHash,
            operation: "upgrade",
            from: from.value,
            to: to.value,
            engineVersion: POSTGRES_SUPPORT.version,
            schemas: schemas.value,
            configurationHash: value.configurationHash,
            maintenanceId: value.maintenanceId,
            production: value.production,
        },
    };
}

function decodeVerificationProblem(value: unknown): ValidationResult<Problem> {
    const decoded = decodeProblemInfo(
        value,
        "$",
        (path, _reason) => path.includes('["details"]["')
            ? failure("deployment.evidenceMismatch", {reason: "verification problem details must be strings"})
            : failure("deployment.evidenceMismatch", {reason: "invalid verification problem"}),
    );
    if (!decoded.ok) return decoded;
    if (!isPgNonEmptyText(decoded.value.messageKey)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid verification problem"});
    }
    return decoded;
}

function decodeCheck(value: unknown): ValidationResult<VerificationCheckInfo> {
    if (!isPlainObject(value)) return failure("deployment.evidenceMismatch", {reason: "invalid verification check"});
    const shape = exactKeys(
        value,
        ["id", "kind", "status", "reportId", "problems"],
        "$",
        () => failure("deployment.evidenceMismatch", {reason: "invalid verification check"}),
    );
    if (!shape.ok
        || !isPgNonEmptyText(value.id)
        || !CHECK_KINDS.includes(value.kind as VerificationKind)
        || !VERIFICATION_STATUSES.includes(value.status as VerificationStatus)
        || !isPgNonEmptyText(value.reportId)
        || !Array.isArray(value.problems)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid verification check"});
    }
    const problems: Problem[] = [];
    for (const one of value.problems) {
        const decoded = decodeVerificationProblem(one);
        if (!decoded.ok) return decoded;
        problems.push(decoded.value);
    }
    return {
        ok: true,
        value: {
            id: value.id,
            kind: value.kind as VerificationKind,
            status: value.status as VerificationStatus,
            reportId: value.reportId,
            problems,
        },
    };
}

function decodeChecks(value: unknown): ValidationResult<readonly VerificationCheckInfo[]> {
    if (!Array.isArray(value)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid verification checks"});
    }
    const checks: VerificationCheckInfo[] = [];
    const ids = new Set<string>();
    for (const one of value) {
        const decoded = decodeCheck(one);
        if (!decoded.ok) return decoded;
        if (ids.has(decoded.value.id)) {
            return failure("deployment.evidenceMismatch", {reason: "duplicate verification check id"});
        }
        ids.add(decoded.value.id);
        checks.push(decoded.value);
    }
    return {ok: true, value: checks};
}

function decodeDraft(value: unknown): ValidationResult<VerificationRunDraft> {
    if (!isPlainObject(value)) return failure("deployment.evidenceMismatch", {reason: "invalid verification run draft"});
    const shape = exactKeys(
        value,
        ["verificationId", "binding", "checks", "createdAt"],
        "$",
        () => failure("deployment.evidenceMismatch", {reason: "invalid verification run draft"}),
    );
    if (!shape.ok
        || !isPgNonEmptyText(value.verificationId)
        || typeof value.createdAt !== "string"
        || !UTC_RE.test(value.createdAt)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid verification run draft"});
    }
    const binding = decodeBinding(value.binding);
    if (!binding.ok) return binding;
    const checks = decodeChecks(value.checks);
    if (!checks.ok) return checks;
    return {
        ok: true,
        value: {
            verificationId: value.verificationId,
            binding: binding.value,
            checks: checks.value,
            createdAt: value.createdAt,
        },
    };
}

function decodeStoredRun(value: VerificationRecordInfo): ValidationResult<VerificationRunInfo> {
    const binding = decodeBinding(value.binding);
    if (!binding.ok) return binding;
    if (binding.value.deploymentId !== value.deploymentId) {
        return failure("deployment.evidenceMismatch", {reason: "verification deployment id does not match binding"});
    }
    const checks = decodeChecks(value.checks);
    if (!checks.ok) return checks;
    return {
        ok: true,
        value: {
            verificationId: value.verificationId,
            ordinal: value.ordinal,
            binding: binding.value,
            status: value.status,
            checks: checks.value,
            createdAt: value.createdAt,
        },
    };
}

function verificationStorageFailure<T>(
    result: ValidationResult<T>,
    fallbackReason: string,
): ValidationResult<T> {
    if (result.ok) return result;
    const first = result.problems[0];
    if (first?.messageKey !== "migration.invalidJournal") return result;
    return failure("deployment.evidenceMismatch", {
        reason: first.details.reason ?? fallbackReason,
    });
}

function requiredKinds(binding: DeploymentBindingInfo): readonly VerificationKind[] {
    const base: VerificationKind[] = ["artifacts", "environment", "structure", "data"];
    if (binding.production && binding.operation === "upgrade") base.push("rehearsal");
    return base;
}

export function deriveVerificationStatus(
    binding: DeploymentBindingInfo,
    checks: readonly VerificationCheckInfo[],
): VerificationStatus {
    if (checks.some(one => one.status === VERIFICATION_STATUS.failed)) return VERIFICATION_STATUS.failed;
    const required = requiredKinds(binding);
    for (const kind of required) {
        const matching = checks.filter(one => one.kind === kind);
        if (matching.length !== 1 || matching[0].status !== VERIFICATION_STATUS.passed) return VERIFICATION_STATUS.incomplete;
    }
    if (checks.some(one => one.status === VERIFICATION_STATUS.incomplete)) return VERIFICATION_STATUS.incomplete;
    return VERIFICATION_STATUS.passed;
}


function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((one, index) => one === right[index]);
}

function sameBinding(left: DeploymentBindingInfo, right: DeploymentBindingInfo): boolean {
    return left.deploymentId === right.deploymentId
        && left.installationId === right.installationId
        && left.candidateApplicationHash === right.candidateApplicationHash
        && left.planHash === right.planHash
        && left.operation === right.operation
        && sameOptionalReleaseRef(left.from, right.from)
        && sameOptionalReleaseRef(left.to, right.to)
        && left.engineVersion === right.engineVersion
        && sameStrings(left.schemas, right.schemas)
        && left.configurationHash === right.configurationHash
        && left.maintenanceId === right.maintenanceId
        && left.production === right.production;
}

function sameProblem(left: Problem, right: Problem): boolean {
    if (left.field !== right.field || left.messageKey !== right.messageKey || left.severity !== right.severity) return false;
    const leftKeys = Object.keys(left.details).sort();
    const rightKeys = Object.keys(right.details).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left.details[key] === right.details[key]);
}

function sameCheck(left: VerificationCheckInfo, right: VerificationCheckInfo): boolean {
    return left.id === right.id
        && left.kind === right.kind
        && left.status === right.status
        && left.reportId === right.reportId
        && left.problems.length === right.problems.length
        && left.problems.every((one, index) => sameProblem(one, right.problems[index]));
}

function sameChecks(left: readonly VerificationCheckInfo[], right: readonly VerificationCheckInfo[]): boolean {
    return left.length === right.length && left.every((one, index) => sameCheck(one, right[index]));
}

export async function recordVerification(
    session: PgSession,
    journal: JournalConfig,
    run: VerificationRunDraft,
): Promise<ValidationResult<VerificationRunInfo>> {
    const checkedJournal = validateJournalConfig(journal);
    if (!checkedJournal.ok) return checkedJournal;
    const decoded = decodeDraft(run);
    if (!decoded.ok) return decoded;
    const status = deriveVerificationStatus(decoded.value.binding, decoded.value.checks);
    const storedResult = await recordVerificationRecord(session, checkedJournal.value, {
        verificationId: decoded.value.verificationId,
        deploymentId: decoded.value.binding.deploymentId,
        binding: decoded.value.binding,
        status,
        checks: decoded.value.checks,
        createdAt: decoded.value.createdAt,
    });
    const storedRecord = verificationStorageFailure(storedResult, "invalid verification journal row");
    if (!storedRecord.ok) return storedRecord;
    const stored = decodeStoredRun(storedRecord.value);
    if (!stored.ok) return stored;
    if (stored.value.verificationId !== decoded.value.verificationId
        || !sameBinding(stored.value.binding, decoded.value.binding)
        || !sameChecks(stored.value.checks, decoded.value.checks)
        || stored.value.createdAt !== decoded.value.createdAt
        || stored.value.status !== status) {
        return failure("deployment.evidenceMismatch", {reason: "stored verification does not match submitted evidence"});
    }
    return stored;
}

export async function readLatestVerification(
    session: PgSession,
    journal: JournalConfig,
    deploymentId: string,
): Promise<ValidationResult<VerificationRunInfo | null>> {
    const checkedJournal = validateJournalConfig(journal);
    if (!checkedJournal.ok) return checkedJournal;
    if (!isPgNonEmptyText(deploymentId)) {
        return failure("deployment.evidenceMismatch", {reason: "invalid deployment id"});
    }
    const storedResult = await readLatestVerificationRecord(session, checkedJournal.value, deploymentId);
    const stored = verificationStorageFailure(storedResult, "invalid verification journal row");
    if (!stored.ok) return stored;
    if (stored.value === null) return {ok: true, value: null};
    const decoded = decodeStoredRun(stored.value);
    if (!decoded.ok) return decoded;
    if (decoded.value.binding.deploymentId !== deploymentId) {
        return failure("deployment.evidenceMismatch", {reason: "verification belongs to another deployment"});
    }
    return decoded;
}

export async function checkApplyEligibility(
    binding: DeploymentBindingInfo,
    context: EvidenceContext,
): Promise<ValidationResult<VerificationRunInfo>> {
    const requested = decodeBinding(binding);
    if (!requested.ok) return requested;
    if (!isPlainObject(context)) return failure("deployment.evidenceMismatch", {reason: "invalid evidence context"});
    const contextShape = exactKeys(
        context,
        ["session", "journal"],
        "$",
        () => failure("deployment.evidenceMismatch", {reason: "invalid evidence context"}),
    );
    if (!contextShape.ok) {
        return failure("deployment.evidenceMismatch", {reason: "invalid evidence context"});
    }
    const latest = await readLatestVerification(context.session, context.journal, requested.value.deploymentId);
    if (!latest.ok) return latest;
    if (latest.value === null) {
        return failure("deployment.verificationMissing");
    }
    if (!sameBinding(latest.value.binding, requested.value)) {
        return failure("deployment.evidenceMismatch");
    }
    const status = deriveVerificationStatus(latest.value.binding, latest.value.checks);
    if (status === VERIFICATION_STATUS.failed || latest.value.status === VERIFICATION_STATUS.failed) {
        return failure("deployment.verificationFailed");
    }
    if (status === VERIFICATION_STATUS.incomplete || latest.value.status === VERIFICATION_STATUS.incomplete) {
        return failure("deployment.verificationIncomplete");
    }
    return {ok: true, value: latest.value};
}

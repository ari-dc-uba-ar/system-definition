import type {Problem, ReleaseRefInfo} from "system-definition";
import type {PgSession} from "./pg-schema";

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

export const VERIFICATION_STATUS = {
    passed: "passed",
    failed: "failed",
    incomplete: "incomplete",
} as const;

export const VERIFICATION_STATUSES = [
    VERIFICATION_STATUS.passed,
    VERIFICATION_STATUS.failed,
    VERIFICATION_STATUS.incomplete,
] as const;

export type VerificationStatus = typeof VERIFICATION_STATUSES[number];

export const DEPLOYMENT_READINESS_STATE = {
    pending: "pending",
    blocked: "blocked",
    ready: "ready",
    consumed: "consumed",
} as const;

export const DEPLOYMENT_READINESS_STATES = [
    DEPLOYMENT_READINESS_STATE.pending,
    DEPLOYMENT_READINESS_STATE.blocked,
    DEPLOYMENT_READINESS_STATE.ready,
    DEPLOYMENT_READINESS_STATE.consumed,
] as const;

export type DeploymentReadinessState = typeof DEPLOYMENT_READINESS_STATES[number];

export interface PgSessionFactory {
    openTarget(): Promise<PgSession>;
}

/** Durable verification row owned by the journal package; JSON payload semantics stay with evidence. */
export type VerificationRecordInfo = {
    verificationId: string;
    ordinal: number;
    deploymentId: string;
    binding: unknown;
    status: VerificationStatus;
    checks: unknown;
    createdAt: string;
};

export type VerificationRecordInput = Omit<VerificationRecordInfo, "ordinal">;

/** Durable readiness write contract; binding/problem payload semantics stay with deployment. */
export type DeploymentReadinessRecordInput = {
    deploymentId: string;
    installationId: string;
    binding: unknown;
    state: DeploymentReadinessState;
    verificationId: string | null;
    applyAttemptId: string | null;
    confirmedTarget: ReleaseRefInfo | null;
    problems: unknown;
};

export type DeploymentReadinessConsumeInput = {
    deploymentId: string;
    installationId: string;
    verificationId: string;
    applyAttemptId: string;
    binding: unknown;
};

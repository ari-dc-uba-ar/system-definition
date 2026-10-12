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

export interface PgSessionFactory {
    openTarget(): Promise<PgSession>;
}

import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
import type {PgSession} from "../src/pg-schema";
import {
    appendCommittedMigration,
    bootstrapJournal,
    finishAttempt,
    installBaseline,
    readHistory,
    readInstallation,
    startAttempt,
    verifyHistory,
    withMigrationLock,
    type AttemptFinishInput,
    type AttemptInfo,
    type AttemptStartInput,
    type InstallationInfo,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
    type PgSessionFactory,
} from "../src/journal";

const journal: JournalConfig = {schema: "system_definition_journal"};
const scope: InstallationScope = {systemId: "aida", schemas: ["app"]};
const release: ReleaseRefInfo = {
    systemId: "aida",
    releaseId: "B",
    releaseHash: "b".repeat(64),
};

const _bootstrap: (
    session: PgSession,
    config: JournalConfig,
) => Promise<ValidationResult<true>> = bootstrapJournal;

const _install: (
    session: PgSession,
    config: JournalConfig,
    input: {installationId: string; scope: InstallationScope; baseline: ReleaseRefInfo},
) => Promise<ValidationResult<InstallationInfo>> = installBaseline;

const _readInstallation: (
    session: PgSession,
    config: JournalConfig,
    scope: InstallationScope,
) => Promise<ValidationResult<InstallationInfo | null>> = readInstallation;

const _readHistory: (
    session: PgSession,
    config: JournalConfig,
    installationId: string,
) => Promise<ValidationResult<readonly MigrationHistoryInfo[]>> = readHistory;

const _verifyHistory: (
    installation: InstallationInfo,
    history: readonly MigrationHistoryInfo[],
) => ValidationResult<readonly MigrationHistoryInfo[]> = verifyHistory;

const _startAttempt: (
    session: PgSession,
    config: JournalConfig,
    input: AttemptStartInput,
) => Promise<ValidationResult<AttemptInfo>> = startAttempt;

const _append: (
    session: PgSession,
    config: JournalConfig,
    expectedHead: ReleaseRefInfo,
    history: MigrationHistoryInfo,
) => Promise<ValidationResult<InstallationInfo>> = appendCommittedMigration;

const _finish: (
    session: PgSession,
    config: JournalConfig,
    attemptId: string,
    result: AttemptFinishInput,
) => Promise<ValidationResult<AttemptInfo>> = finishAttempt;

const _withLock: <T>(
    factory: PgSessionFactory,
    scope: InstallationScope,
    lockWaitTimeoutMs: number,
    work: (session: PgSession) => Promise<ValidationResult<T>>,
) => Promise<ValidationResult<T>> = withMigrationLock;

const problem: Problem = {
    field: null,
    messageKey: "migration.failed",
    severity: "blocking",
    details: {},
};
const attempt: AttemptInfo = {
    attemptId: "attempt-1",
    deploymentId: "deploy-1",
    installationId: "installation-1",
    planHash: "c".repeat(64),
    state: "failed",
    confirmedTarget: null,
    problems: [problem],
};
const history: MigrationHistoryInfo = {
    installationId: "installation-1",
    ordinal: 1,
    migrationId: "B-C",
    migrationHash: "d".repeat(64),
    from: release,
    to: {...release, releaseId: "C", releaseHash: "e".repeat(64)},
    committedAt: "2026-09-28T12:00:00.000Z",
};

void journal;
void scope;
void _bootstrap;
void _install;
void _readInstallation;
void _readHistory;
void _verifyHistory;
void _startAttempt;
void _append;
void _finish;
void _withLock;
void attempt;
void history;

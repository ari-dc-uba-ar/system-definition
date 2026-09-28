import type {
    Problem,
    PublishedMigrationInfo,
    ReleaseRefInfo,
    ValidationResult,
} from "system-definition";
import type {InstallationScope, JournalConfig} from "../src/journal";
import type {PgSession} from "../src/pg-schema";
import {
    reconcileCommitOutcome,
    type CommitOutcomeInfo,
    type CommitOutcomeState,
    type CommitReconciliationContext,
} from "../src/recovery";

type ExpectedState = "failed" | "unknown" | "succeeded";
type Assert<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type Equal<A, B> = IsAssignable<A, B> extends true
    ? IsAssignable<B, A> extends true ? true : false
    : false;

type _stateExact = Assert<Equal<CommitOutcomeState, ExpectedState>>;

type ExpectedContext = {
    journal: JournalConfig;
    scope: InstallationScope;
};
type _contextExact = Assert<Equal<CommitReconciliationContext, ExpectedContext>>;

type ExpectedInfo = {
    attemptId: string;
    migrationId: string;
    migrationHash: string;
    state: CommitOutcomeState;
    confirmedHead: ReleaseRefInfo | null;
    retryAllowed: boolean;
    deploymentBlocked: boolean;
    keepMaintenance: true;
    problems: readonly Problem[];
};
type _infoExact = Assert<Equal<CommitOutcomeInfo, ExpectedInfo>>;

const expectedSignature: (
    session: PgSession,
    attemptId: string,
    migration: PublishedMigrationInfo,
    context: CommitReconciliationContext,
) => Promise<ValidationResult<CommitOutcomeInfo>> = reconcileCommitOutcome;

void expectedSignature;

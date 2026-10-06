import {
    sameReleaseRef,
    type FileInfo,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import type {RehearsalCopyRef} from "./rehearsal-copy";
import {
    executeMigrationPreparation,
    type MigrationExecutionContext,
} from "./execute-migration";
import {
    finishPreparationAttempt,
    readConfirmedPreparation,
    recordConfirmedPreparation,
    startPreparationAttempt,
    withMigrationLock,
    type InstallationScope,
    type JournalConfig,
    type PgSessionFactory,
} from "./journal";
import type {PgSession} from "./pg-schema";
import {
    decodePreparationArtifact,
    type PreparationArtifactInfo,
} from "./preparation-artifact";
import {
    checkCurrentPreparationPreconditions,
    checkPreparationPreconditions,
    type PreparationCurrentStateInfo,
    type PreparationPreflightStateInfo,
} from "./preparation-preflight";
import {invalidPreparation as fail} from "./preparation-error";

export type PreparationReceiptInfo = {
    preparationId: string;
    artifactHash: string;
    installationId: string;
    head: ReleaseRefInfo;
    inputFingerprint: string;
    status: "passed" | "failed" | "incomplete";
    checks: readonly {id: string; report: FileInfo; passed: boolean}[];
};

export type PreparationExecutionTarget =
    | {kind: "copy"; copy: RehearsalCopyRef}
    | {kind: "installation"; installationId: string};

export interface PreparationExecutionRuntime {
    journal: JournalConfig;
    scope: InstallationScope;
    sessions: PgSessionFactory;
    lockWaitTimeoutMs: number;
    inspectCopy(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        copy: RehearsalCopyRef,
    ): Promise<ValidationResult<PreparationPreflightStateInfo>>;
    inspectInstallation(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        installationId: string,
    ): Promise<ValidationResult<PreparationCurrentStateInfo>>;
    resolveExecutionContext(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        target: PreparationExecutionTarget,
    ): Promise<ValidationResult<MigrationExecutionContext>>;
    fingerprintInputs(
        session: PgSession,
        artifact: PreparationArtifactInfo,
        target: PreparationExecutionTarget,
    ): Promise<ValidationResult<string>>;
    now(): string;
    attemptId(artifact: PreparationArtifactInfo): string;
}

function validReceipt(artifact: PreparationArtifactInfo, receipt: PreparationReceiptInfo): boolean {
    return receipt !== null && typeof receipt === "object"
        && receipt.preparationId === artifact.id
        && receipt.artifactHash === artifact.artifactHash
        && receipt.installationId === artifact.installationId
        && sameReleaseRef(receipt.head, artifact.head)
        && receipt.inputFingerprint === artifact.inputFingerprint
        && receipt.status === "passed"
        && Array.isArray(receipt.checks)
        && receipt.checks.every(check => check !== null && typeof check === "object"
            && typeof check.id === "string" && check.id.length > 0
            && typeof check.passed === "boolean"
            && check.report !== null && typeof check.report === "object");
}

function executionMigration(artifact: PreparationArtifactInfo) {
    return {
        id: artifact.id,
        from: artifact.head,
        to: artifact.head,
        description: `preparation ${artifact.id}`,
        before: artifact.before,
        steps: artifact.steps,
        after: artifact.after,
    };
}

function passedReceipt(artifact: PreparationArtifactInfo): PreparationReceiptInfo {
    return {
        preparationId: artifact.id,
        artifactHash: artifact.artifactHash,
        installationId: artifact.installationId,
        head: artifact.head,
        inputFingerprint: artifact.inputFingerprint,
        status: "passed",
        checks: [],
    };
}

function failedReceipt(artifact: PreparationArtifactInfo): PreparationReceiptInfo {
    return {
        preparationId: artifact.id,
        artifactHash: artifact.artifactHash,
        installationId: artifact.installationId,
        head: artifact.head,
        inputFingerprint: artifact.inputFingerprint,
        status: "failed",
        checks: [],
    };
}

function incompleteReceipt(artifact: PreparationArtifactInfo): PreparationReceiptInfo {
    return {
        preparationId: artifact.id,
        artifactHash: artifact.artifactHash,
        installationId: artifact.installationId,
        head: artifact.head,
        inputFingerprint: artifact.inputFingerprint,
        status: "incomplete",
        checks: [],
    };
}

/** Verify a resolution only on an identified copy. It never confirms a preparation in the production journal. */
export async function verifyResolution(
    artifact: PreparationArtifactInfo,
    copy: RehearsalCopyRef,
    runtime: PreparationExecutionRuntime,
): Promise<ValidationResult<PreparationReceiptInfo>> {
    const decoded = decodePreparationArtifact(artifact, artifact.expectedSchemaHash);
    if (!decoded.ok) return decoded;
    const target: PreparationExecutionTarget = {kind: "copy", copy};
    return withMigrationLock(runtime.sessions, runtime.scope, runtime.lockWaitTimeoutMs, async session => {
        const state = await runtime.inspectCopy(session, decoded.value, copy);
        if (!state.ok) return state;
        const preflight = checkPreparationPreconditions(decoded.value, state.value);
        if (!preflight.ok) return preflight;
        const currentFingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
        if (!currentFingerprint.ok) return currentFingerprint;
        if (currentFingerprint.value !== decoded.value.inputFingerprint) {
            return fail("preparation input fingerprint changed");
        }
        const context = await runtime.resolveExecutionContext(session, decoded.value, target);
        if (!context.ok) return context;
        const executed = await executeMigrationPreparation(
            session,
            executionMigration(decoded.value),
            context.value,
        );
        if (!executed.ok) return executed;
        const afterFingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
        if (!afterFingerprint.ok) return afterFingerprint;
        return {ok: true, value: passedReceipt(decoded.value)};
    });
}

/**
 * Apply an already-verified resolution to the installation. A confirmed artifact is
 * an idempotent no-op only when the current fingerprint still equals the recorded
 * post-preparation fingerprint. Ambiguous COMMIT is reconciled from preparations.
 */
export async function applyResolution(
    artifact: PreparationArtifactInfo,
    receipt: PreparationReceiptInfo,
    runtime: PreparationExecutionRuntime,
): Promise<ValidationResult<PreparationReceiptInfo>> {
    const decoded = decodePreparationArtifact(artifact, artifact.expectedSchemaHash);
    if (!decoded.ok) return decoded;
    if (!validReceipt(decoded.value, receipt)) return fail("preparation receipt is incomplete or does not match artifact");
    const target: PreparationExecutionTarget = {kind: "installation", installationId: artifact.installationId};

    return withMigrationLock(runtime.sessions, runtime.scope, runtime.lockWaitTimeoutMs, async session => {
        const existing = await readConfirmedPreparation(
            session,
            runtime.journal,
            decoded.value.installationId,
            decoded.value.id,
        );
        if (!existing.ok) return existing;
        if (existing.value !== null) {
            if (existing.value.artifactHash !== decoded.value.artifactHash) {
                return fail("preparation id already confirmed for another artifact");
            }
            const fingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
            if (!fingerprint.ok) return fingerprint;
            if (fingerprint.value !== existing.value.afterFingerprint) {
                return fail("confirmed preparation state changed after success");
            }
            return {ok: true, value: passedReceipt(decoded.value)};
        }

        const state = await runtime.inspectInstallation(session, decoded.value, decoded.value.installationId);
        if (!state.ok) return state;
        const preflight = checkCurrentPreparationPreconditions(decoded.value, state.value);
        if (!preflight.ok) return preflight;
        const beforeFingerprint = await runtime.fingerprintInputs(session, decoded.value, target);
        if (!beforeFingerprint.ok) return beforeFingerprint;
        if (beforeFingerprint.value !== decoded.value.inputFingerprint) {
            return fail("preparation input fingerprint changed");
        }

        const attemptId = runtime.attemptId(decoded.value);
        const started = await startPreparationAttempt(session, runtime.journal, {
            attemptId,
            installationId: decoded.value.installationId,
            preparationId: decoded.value.id,
            artifactHash: decoded.value.artifactHash,
            beforeFingerprint: beforeFingerprint.value,
            reportHash: decoded.value.reportHash,
        });
        if (!started.ok) return started;

        const context = await runtime.resolveExecutionContext(session, decoded.value, target);
        if (!context.ok) {
            await finishPreparationAttempt(session, runtime.journal, attemptId, {
                state: "failed",
                afterFingerprint: null,
                problems: context.problems,
            });
            return context;
        }

        let afterFingerprint: string | null = null;
        const executed = await executeMigrationPreparation(
            session,
            executionMigration(decoded.value),
            context.value,
            async transactionSession => {
                const captured = await runtime.fingerprintInputs(transactionSession, decoded.value, target);
                if (!captured.ok) return captured;
                afterFingerprint = captured.value;
                const committedAt = runtime.now();
                const recorded = await recordConfirmedPreparation(transactionSession, runtime.journal, {
                    installationId: decoded.value.installationId,
                    preparationId: decoded.value.id,
                    artifactHash: decoded.value.artifactHash,
                    head: decoded.value.head,
                    beforeFingerprint: beforeFingerprint.value,
                    afterFingerprint: captured.value,
                    reportHash: decoded.value.reportHash,
                    committedAt,
                });
                if (!recorded.ok) return recorded;
                return {ok: true, value: true};
            },
        );

        if (!executed.ok) {
            const unknown = executed.problems.some(one => one.messageKey === "migration.commitUnknown");
            if (unknown) {
                const reconciled = await readConfirmedPreparation(
                    session,
                    runtime.journal,
                    decoded.value.installationId,
                    decoded.value.id,
                );
                if (!reconciled.ok) return reconciled;
                if (reconciled.value !== null && reconciled.value.artifactHash === decoded.value.artifactHash) {
                    const finished = await finishPreparationAttempt(session, runtime.journal, attemptId, {
                        state: "succeeded",
                        afterFingerprint: reconciled.value.afterFingerprint,
                        problems: [],
                    });
                    if (!finished.ok) return finished;
                    return {ok: true, value: passedReceipt(decoded.value)};
                }
                await finishPreparationAttempt(session, runtime.journal, attemptId, {
                    state: "unknown",
                    afterFingerprint,
                    problems: executed.problems,
                });
                return executed;
            }
            await finishPreparationAttempt(session, runtime.journal, attemptId, {
                state: "failed",
                afterFingerprint,
                problems: executed.problems,
            });
            return executed;
        }

        const finished = await finishPreparationAttempt(session, runtime.journal, attemptId, {
            state: "succeeded",
            afterFingerprint,
            problems: [],
        });
        if (!finished.ok) return finished;
        return {ok: true, value: passedReceipt(decoded.value)};
    });
}

// Keep these constructors explicit so callers persisting diagnostic receipts can
// distinguish execution failure from an interrupted/incomplete verification.
export const preparationReceiptStatus = {
    passed: passedReceipt,
    failed: failedReceipt,
    incomplete: incompleteReceipt,
} as const;

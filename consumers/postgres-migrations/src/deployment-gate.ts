import {
    problem,
    type Problem,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    checkApplyEligibility,
    type DeploymentBindingInfo,
    type VerificationRunInfo,
} from "./evidence";
import {
    readInstallation,
    readLatestAttempt,
    type AttemptInfo,
    type JournalConfig,
} from "./journal";
import {
    quotePgIdentifier,
    type PgSession,
    type SqlParameter,
} from "./pg-schema";

export type DeploymentReadinessInfo = {
    binding: DeploymentBindingInfo;
    state: "pending" | "blocked" | "ready" | "consumed";
    verificationId: string | null;
    applyAttemptId: string | null;
    confirmedTarget: ReleaseRefInfo | null;
    problems: readonly Problem[];
};

export type DeploymentReadyInfo = {
    binding: DeploymentBindingInfo;
    verificationId: string;
    applyAttemptId: string;
    confirmedTarget: ReleaseRefInfo;
};

export type DeploymentGateRuntime = {
    session: PgSession;
    journal: JournalConfig;
    maintenance: {
        isActive(maintenanceId: string, installationId: string): Promise<boolean>;
    };
    finalChecks(
        session: PgSession,
        binding: DeploymentBindingInfo,
    ): Promise<ValidationResult<true>>;
};

export type DeploymentPipelineRuntime = DeploymentGateRuntime & {
    exclusivity: {
        runExclusive<T>(
            deploymentId: string,
            installationId: string,
            work: () => Promise<ValidationResult<T>>,
        ): Promise<ValidationResult<T>>;
    };
    apply(binding: DeploymentBindingInfo): Promise<ValidationResult<true>>;
    activate(candidateApplicationHash: string): Promise<ValidationResult<true>>;
    completeMaintenance(maintenanceId: string): Promise<ValidationResult<true>>;
};

type QueryResult = Awaited<ReturnType<PgSession["query"]>>;

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

function sameRelease(left: ReleaseRefInfo, right: ReleaseRefInfo): boolean {
    return left.systemId === right.systemId
        && left.releaseId === right.releaseId
        && left.releaseHash === right.releaseHash;
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

function readinessTable(journal: JournalConfig): string {
    return `${quotePgIdentifier(journal.schema)}.deployment_readiness`;
}

async function writeReadiness(
    runtime: DeploymentGateRuntime,
    info: DeploymentReadinessInfo,
): Promise<ValidationResult<true>> {
    const table = readinessTable(runtime.journal);
    const text = `INSERT INTO ${table} (
        deployment_id, installation_id, binding, state, verification_id, apply_attempt_id,
        confirmed_target_system_id, confirmed_target_release_id, confirmed_target_release_hash,
        problems, updated_at
    ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,clock_timestamp())
    ON CONFLICT (deployment_id) DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        binding = EXCLUDED.binding,
        state = EXCLUDED.state,
        verification_id = EXCLUDED.verification_id,
        apply_attempt_id = EXCLUDED.apply_attempt_id,
        confirmed_target_system_id = EXCLUDED.confirmed_target_system_id,
        confirmed_target_release_id = EXCLUDED.confirmed_target_release_id,
        confirmed_target_release_hash = EXCLUDED.confirmed_target_release_hash,
        problems = EXCLUDED.problems,
        updated_at = clock_timestamp()`;
    const result = await safeQuery(runtime.session, text, [
        info.binding.deploymentId,
        info.binding.installationId,
        JSON.stringify(info.binding),
        info.state,
        info.verificationId,
        info.applyAttemptId,
        info.confirmedTarget?.systemId ?? null,
        info.confirmedTarget?.releaseId ?? null,
        info.confirmedTarget?.releaseHash ?? null,
        JSON.stringify(info.problems),
    ]);
    if (!result.ok) return result;
    return {ok: true, value: true};
}

async function writeBlocked(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
    problems: readonly Problem[],
    verificationId: string | null = null,
    applyAttemptId: string | null = null,
    confirmedTarget: ReleaseRefInfo | null = null,
): Promise<void> {
    await writeReadiness(runtime, {
        binding,
        state: "blocked",
        verificationId,
        applyAttemptId,
        confirmedTarget,
        problems,
    });
}

async function maintenanceActive(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
): Promise<ValidationResult<true>> {
    try {
        const active = await runtime.maintenance.isActive(binding.maintenanceId, binding.installationId);
        if (!active) return failure("deployment.maintenanceRequired");
        return {ok: true, value: true};
    } catch (error) {
        return failure("deployment.maintenanceRequired", {
            reason: error instanceof Error ? error.message : "maintenance status unavailable",
        });
    }
}

async function latestApplyAttempt(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
): Promise<ValidationResult<AttemptInfo>> {
    const attempt = await readLatestAttempt(
        runtime.session,
        runtime.journal,
        binding.deploymentId,
        binding.installationId,
        binding.planHash,
    );
    if (!attempt.ok) {
        const first = attempt.problems[0];
        if (first?.messageKey === "migration.invalidJournal") {
            return failure("deployment.blocked", {
                reason: first.details.reason ?? "invalid execution attempt row",
            });
        }
        return attempt;
    }
    if (attempt.value === null) {
        return failure("deployment.targetNotReady", {reason: "no apply attempt confirms the target"});
    }
    if (attempt.value.state !== "succeeded"
        || attempt.value.confirmedTarget === null
        || !sameRelease(attempt.value.confirmedTarget, binding.to)) {
        return failure("deployment.targetNotReady", {reason: "latest apply attempt did not confirm the exact target"});
    }
    return {ok: true, value: attempt.value};
}

async function verifyDurableTarget(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
): Promise<ValidationResult<ReleaseRefInfo>> {
    const installation = await readInstallation(runtime.session, runtime.journal, {
        systemId: binding.to.systemId,
        schemas: binding.schemas,
    });
    if (!installation.ok) return installation;
    if (installation.value === null
        || installation.value.installationId !== binding.installationId
        || !sameRelease(installation.value.current, binding.to)) {
        return failure("deployment.targetNotReady", {reason: "journal head is not the exact deployment target"});
    }
    return {ok: true, value: installation.value.current};
}

async function eligibleVerification(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
): Promise<ValidationResult<VerificationRunInfo>> {
    return checkApplyEligibility(binding, {session: runtime.session, journal: runtime.journal});
}

export async function checkDeploymentReady(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
): Promise<ValidationResult<DeploymentReadyInfo>> {
    const evidence = await eligibleVerification(binding, runtime);
    if (!evidence.ok) {
        await writeBlocked(binding, runtime, evidence.problems);
        return evidence;
    }

    const maintenance = await maintenanceActive(binding, runtime);
    if (!maintenance.ok) {
        await writeBlocked(binding, runtime, maintenance.problems, evidence.value.verificationId);
        return maintenance;
    }

    const head = await verifyDurableTarget(binding, runtime);
    if (!head.ok) {
        await writeBlocked(binding, runtime, head.problems, evidence.value.verificationId);
        return head;
    }

    const attempt = await latestApplyAttempt(binding, runtime);
    if (!attempt.ok) {
        await writeBlocked(binding, runtime, attempt.problems, evidence.value.verificationId, null, head.value);
        return attempt;
    }

    let checks: ValidationResult<true>;
    try {
        checks = await runtime.finalChecks(runtime.session, binding);
    } catch (error) {
        checks = failure("deployment.targetNotReady", {
            reason: error instanceof Error ? error.message : "final target checks failed",
        });
    }
    if (!checks.ok) {
        const notReadyProblem = problem(
            null,
            "deployment.targetNotReady",
            "blocking",
            {reason: checks.problems[0]?.messageKey ?? "final target checks failed"},
        );
        const notReady: ValidationResult<DeploymentReadyInfo> = {ok: false, problems: [notReadyProblem]};
        await writeBlocked(
            binding,
            runtime,
            [notReadyProblem],
            evidence.value.verificationId,
            attempt.value.attemptId,
            head.value,
        );
        return notReady;
    }

    const ready: DeploymentReadinessInfo = {
        binding,
        state: "ready",
        verificationId: evidence.value.verificationId,
        applyAttemptId: attempt.value.attemptId,
        confirmedTarget: head.value,
        problems: [],
    };
    const stored = await writeReadiness(runtime, ready);
    if (!stored.ok) return stored;
    return {
        ok: true,
        value: {
            binding,
            verificationId: evidence.value.verificationId,
            applyAttemptId: attempt.value.attemptId,
            confirmedTarget: head.value,
        },
    };
}

async function markPending(
    binding: DeploymentBindingInfo,
    runtime: DeploymentGateRuntime,
    verificationId: string,
): Promise<ValidationResult<true>> {
    return writeReadiness(runtime, {
        binding,
        state: "pending",
        verificationId,
        applyAttemptId: null,
        confirmedTarget: null,
        problems: [],
    });
}

async function consumeReady(
    ready: DeploymentReadyInfo,
    runtime: DeploymentGateRuntime,
): Promise<ValidationResult<true>> {
    const table = readinessTable(runtime.journal);
    const text = `UPDATE ${table}
        SET state = 'consumed', updated_at = clock_timestamp()
        WHERE deployment_id = $1
          AND installation_id = $2
          AND state = 'ready'
          AND verification_id = $3
          AND apply_attempt_id = $4
          AND binding = $5::jsonb`;
    const result = await safeQuery(runtime.session, text, [
        ready.binding.deploymentId,
        ready.binding.installationId,
        ready.verificationId,
        ready.applyAttemptId,
        JSON.stringify(ready.binding),
    ]);
    if (!result.ok) return result;
    if (result.value.rowCount !== null && result.value.rowCount !== 1) {
        return failure("deployment.blocked", {reason: "ready deployment could not be consumed exactly once"});
    }
    return {ok: true, value: true};
}

export async function runDeploymentPipeline(
    binding: DeploymentBindingInfo,
    runtime: DeploymentPipelineRuntime,
): Promise<ValidationResult<DeploymentReadyInfo>> {
    return runtime.exclusivity.runExclusive(
        binding.deploymentId,
        binding.installationId,
        async () => {
            const evidence = await eligibleVerification(binding, runtime);
            if (!evidence.ok) {
                await writeBlocked(binding, runtime, evidence.problems);
                return evidence;
            }

            const maintenance = await maintenanceActive(binding, runtime);
            if (!maintenance.ok) {
                await writeBlocked(binding, runtime, maintenance.problems, evidence.value.verificationId);
                return maintenance;
            }

            const pending = await markPending(binding, runtime, evidence.value.verificationId);
            if (!pending.ok) return pending;

            let applied: ValidationResult<true>;
            try {
                applied = await runtime.apply(binding);
            } catch (error) {
                applied = failure("deployment.blocked", {
                    reason: error instanceof Error ? error.message : "apply failed",
                });
            }
            if (!applied.ok) {
                await writeBlocked(binding, runtime, applied.problems, evidence.value.verificationId);
                return applied;
            }

            const ready = await checkDeploymentReady(binding, runtime);
            if (!ready.ok) return ready;

            let activated: ValidationResult<true>;
            try {
                activated = await runtime.activate(ready.value.binding.candidateApplicationHash);
            } catch (error) {
                activated = failure("deployment.blocked", {
                    reason: error instanceof Error ? error.message : "application activation failed",
                });
            }
            if (!activated.ok) return activated;

            const consumed = await consumeReady(ready.value, runtime);
            if (!consumed.ok) return consumed;

            let maintenanceCompleted: ValidationResult<true>;
            try {
                maintenanceCompleted = await runtime.completeMaintenance(binding.maintenanceId);
            } catch (error) {
                maintenanceCompleted = failure("deployment.blocked", {
                    reason: error instanceof Error ? error.message : "maintenance completion failed",
                });
            }
            if (!maintenanceCompleted.ok) return maintenanceCompleted;

            return ready;
        },
    );
}

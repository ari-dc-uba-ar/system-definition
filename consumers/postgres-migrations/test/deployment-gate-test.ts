import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
import {
    type DeploymentBindingInfo,
    type VerificationCheckInfo,
    type VerificationRunInfo,
} from "../src/evidence";
import {bootstrapJournal, type JournalConfig} from "../src/journal";
import type {PgSession, SqlParameter} from "../src/pg-schema";
import {
    checkDeploymentReady,
    runDeploymentPipeline,
    type DeploymentPipelineRuntime,
} from "../src/deployment-gate";

const journal: JournalConfig = {schema: "sd_journal"};
const A: ReleaseRefInfo = {systemId: "aida", releaseId: "A", releaseHash: "a".repeat(64)};
const B: ReleaseRefInfo = {systemId: "aida", releaseId: "B", releaseHash: "b".repeat(64)};

type QueryResult = {rows: readonly Readonly<Record<string, unknown>>[]; rowCount: number | null};
type QueryCall = {text: string; values: readonly SqlParameter[]};

type AttemptState = "running" | "failed" | "unknown" | "succeeded";
type AttemptRecord = {
    attemptId: string;
    deploymentId: string;
    installationId: string;
    planHash: string;
    state: AttemptState;
    confirmedTarget: ReleaseRefInfo | null;
    problems: readonly Problem[];
};

function issue(messageKey: string): Problem {
    return {field: null, messageKey, severity: "blocking", details: {}};
}

function binding(overrides: Partial<DeploymentBindingInfo> = {}): DeploymentBindingInfo {
    return {
        deploymentId: "deployment-1",
        installationId: "installation-1",
        candidateApplicationHash: "c".repeat(64),
        planHash: "d".repeat(64),
        operation: "upgrade",
        from: A,
        to: B,
        engineVersion: "18.6",
        schemas: ["app"],
        configurationHash: "e".repeat(64),
        maintenanceId: "maintenance-1",
        production: true,
        ...overrides,
    } as DeploymentBindingInfo;
}

function verificationCheck(
    kind: VerificationCheckInfo["kind"],
    status: VerificationCheckInfo["status"] = "passed",
): VerificationCheckInfo {
    return {
        id: `check-${kind}`,
        kind,
        status,
        reportId: `report-${kind}`,
        problems: status === "failed" ? [issue("migration.checkFailed")] : [],
    };
}

function verification(
    bindingValue: DeploymentBindingInfo = binding(),
    status: VerificationRunInfo["status"] = "passed",
    ordinal = 1,
): VerificationRunInfo {
    const checks = [
        verificationCheck("artifacts"),
        verificationCheck("environment"),
        verificationCheck("structure"),
        verificationCheck("data"),
        verificationCheck("rehearsal"),
    ];
    if (status === "failed") checks[2] = verificationCheck("structure", "failed");
    if (status === "incomplete") checks.pop();
    return {
        verificationId: `verification-${ordinal}`,
        ordinal,
        binding: bindingValue,
        status,
        checks,
        createdAt: `2026-09-28T20:0${ordinal}:00.000Z`,
    };
}

function verificationRow(value: VerificationRunInfo): Readonly<Record<string, unknown>> {
    return {
        verification_id: value.verificationId,
        ordinal: value.ordinal,
        deployment_id: value.binding.deploymentId,
        binding: value.binding,
        status: value.status,
        checks: value.checks,
        created_at: value.createdAt,
    };
}

function installationRow(current: ReleaseRefInfo, requested = binding()): Readonly<Record<string, unknown>> {
    return {
        installation_id: requested.installationId,
        system_id: current.systemId,
        schemas: [...requested.schemas],
        baseline_system_id: A.systemId,
        baseline_release_id: A.releaseId,
        baseline_release_hash: A.releaseHash,
        current_system_id: current.systemId,
        current_release_id: current.releaseId,
        current_release_hash: current.releaseHash,
        journal_format_version: 1,
    };
}

function attemptRow(value: AttemptRecord): Readonly<Record<string, unknown>> {
    return {
        attempt_id: value.attemptId,
        deployment_id: value.deploymentId,
        installation_id: value.installationId,
        plan_hash: value.planHash,
        state: value.state,
        confirmed_target_system_id: value.confirmedTarget?.systemId ?? null,
        confirmed_target_release_id: value.confirmedTarget?.releaseId ?? null,
        confirmed_target_release_hash: value.confirmedTarget?.releaseHash ?? null,
        problems: value.problems,
    };
}

function succeededAttempt(requested = binding(), target = B): AttemptRecord {
    return {
        attemptId: "attempt-1",
        deploymentId: requested.deploymentId,
        installationId: requested.installationId,
        planHash: requested.planHash,
        state: "succeeded",
        confirmedTarget: target,
        problems: [],
    };
}

class GateSession implements PgSession {
    readonly calls: QueryCall[] = [];
    readonly events: string[];
    verification: VerificationRunInfo | null;
    current: ReleaseRefInfo;
    attempts: AttemptRecord[];
    readiness: "pending" | "blocked" | "ready" | "consumed" | null = null;
    closed = false;

    constructor(options: {
        verification?: VerificationRunInfo | null;
        current?: ReleaseRefInfo;
        attempts?: AttemptRecord[];
        events?: string[];
    } = {}) {
        this.verification = options.verification === undefined ? verification() : options.verification;
        this.current = options.current ?? B;
        this.attempts = options.attempts ?? [succeededAttempt()];
        this.events = options.events ?? [];
    }

    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        const parameterNumbers = [...text.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
        const expectedParameterCount = parameterNumbers.length === 0 ? 0 : Math.max(...parameterNumbers);
        assert.equal(
            values.length,
            expectedParameterCount,
            `query bind count must match PostgreSQL placeholders: ${text}`,
        );
        this.calls.push({text, values});
        if (/verification_run/i.test(text) && /select/i.test(text)) {
            return this.verification === null
                ? {rows: [], rowCount: 0}
                : {rows: [verificationRow(this.verification)], rowCount: 1};
        }
        if (/\bfrom\s+"sd_journal"\.installation\b/i.test(text)) {
            return {rows: [installationRow(this.current)], rowCount: 1};
        }
        if (/execution_attempt/i.test(text) && /select/i.test(text)) {
            return {rows: this.attempts.map(attemptRow), rowCount: this.attempts.length};
        }
        if (/deployment_readiness/i.test(text) && /(insert|update)/i.test(text)) {
            const lower = text.toLowerCase();
            const next = lower.includes("'consumed'") || values.includes("consumed")
                ? "consumed"
                : lower.includes("'ready'") || values.includes("ready")
                    ? "ready"
                    : lower.includes("'blocked'") || values.includes("blocked")
                        ? "blocked"
                        : "pending";
            this.readiness = next;
            this.events.push(`readiness:${next}`);
            return {rows: [], rowCount: 1};
        }
        if (/deployment_readiness/i.test(text) && /select/i.test(text)) {
            return {rows: [], rowCount: 0};
        }
        return {rows: [], rowCount: 0};
    }

    async close(): Promise<void> { this.closed = true; }
}

class Maintenance {
    active = true;
    readonly events: string[];
    constructor(events: string[]) { this.events = events; }
    async isActive(_maintenanceId: string, _installationId: string): Promise<boolean> {
        this.events.push("maintenance:check");
        return this.active;
    }
    async complete(maintenanceId: string): Promise<ValidationResult<true>> {
        this.events.push(`maintenance:complete:${maintenanceId}`);
        this.active = false;
        return {ok: true, value: true};
    }
}

class Exclusivity {
    held = false;
    readonly events: string[];
    constructor(events: string[]) { this.events = events; }
    async runExclusive<T>(
        deploymentId: string,
        installationId: string,
        work: () => Promise<ValidationResult<T>>,
    ): Promise<ValidationResult<T>> {
        assert.equal(this.held, false, "deployment exclusion must not be recursively acquired");
        this.held = true;
        this.events.push(`exclusive:enter:${deploymentId}:${installationId}`);
        try {
            return await work();
        } finally {
            this.events.push("exclusive:exit");
            this.held = false;
        }
    }
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

function runtime(options: {
    session?: GateSession;
    finalOk?: boolean;
    apply?: (requested: DeploymentBindingInfo) => Promise<ValidationResult<true>>;
    activate?: (hash: string) => Promise<ValidationResult<true>>;
} = {}): {runtime: DeploymentPipelineRuntime; session: GateSession; events: string[]; maintenance: Maintenance; counters: {apply: number; activate: number}} {
    const events: string[] = [];
    const session = options.session ?? new GateSession({events});
    if (session.events !== events) {
        // Keep externally supplied session events visible in the same trace.
        (session.events as string[]).splice(0, session.events.length, ...events);
    }
    const maintenance = new Maintenance(session.events);
    const exclusivity = new Exclusivity(session.events);
    const counters = {apply: 0, activate: 0};
    const value: DeploymentPipelineRuntime = {
        session,
        journal,
        maintenance: {isActive: (id: string, installationId: string) => maintenance.isActive(id, installationId)},
        finalChecks: async () => {
            session.events.push("final-checks");
            return options.finalOk === false
                ? {ok: false, problems: [issue("migration.checkFailed")]}
                : {ok: true, value: true};
        },
        exclusivity,
        apply: async (requested: DeploymentBindingInfo) => {
            counters.apply += 1;
            session.events.push("apply");
            if (options.apply !== undefined) return options.apply(requested);
            session.current = requested.to;
            session.attempts = [succeededAttempt(requested, requested.to)];
            return {ok: true, value: true};
        },
        activate: async (hash: string) => {
            counters.activate += 1;
            session.events.push(`activate:${hash}`);
            return options.activate === undefined ? {ok: true, value: true} : options.activate(hash);
        },
        completeMaintenance: (id: string) => maintenance.complete(id),
    };
    return {runtime: value, session, events: session.events, maintenance, counters};
}

describe("deployment activation gate and simulated pipeline", () => {
    it("owns durable readiness and every verification/preflight/final-check negative performs zero activations", async () => {
        const boot = new GateSession();
        const bootstrapped = await bootstrapJournal(boot, journal);
        assert.equal(bootstrapped.ok, true);
        assert.ok(boot.calls.some(one => /create\s+table[\s\S]*deployment_readiness/i.test(one.text)),
            "journal bootstrap must own durable deployment readiness");

        const missing = runtime({session: new GateSession({verification: null})});
        const missingResult = await runDeploymentPipeline(binding(), missing.runtime);
        assert.equal(firstKey(missingResult), "deployment.verificationMissing");
        assert.deepEqual(missing.counters, {apply: 0, activate: 0});

        const failed = runtime({session: new GateSession({verification: verification(binding(), "failed", 2)})});
        const failedResult = await runDeploymentPipeline(binding(), failed.runtime);
        assert.equal(firstKey(failedResult), "deployment.verificationFailed");
        assert.deepEqual(failed.counters, {apply: 0, activate: 0});

        const mismatchBinding = binding({candidateApplicationHash: "f".repeat(64)});
        const mismatched = runtime({session: new GateSession({verification: verification(binding(), "passed", 3)})});
        const mismatchedRuntime = {...mismatched.runtime, force: true, skipGate: true, continueOnError: true} as unknown as DeploymentPipelineRuntime;
        const mismatchResult = await runDeploymentPipeline(mismatchBinding, mismatchedRuntime);
        assert.equal(firstKey(mismatchResult), "deployment.evidenceMismatch");
        assert.deepEqual(mismatched.counters, {apply: 0, activate: 0}, "force/skip/continue flags must never bypass the gate");

        const preflight = runtime({
            apply: async () => ({ok: false, problems: [issue("migration.schemaDrift")]}),
        });
        const preflightResult = await runDeploymentPipeline(binding(), preflight.runtime);
        assert.equal(preflightResult.ok, false);
        assert.deepEqual(preflight.counters, {apply: 1, activate: 0});
        assert.equal(preflight.maintenance.active, true);

        const finalCheck = runtime({finalOk: false});
        const finalResult = await runDeploymentPipeline(binding(), finalCheck.runtime);
        assert.equal(finalResult.ok, false);
        assert.equal(firstKey(finalResult), "deployment.targetNotReady");
        assert.deepEqual(finalCheck.counters, {apply: 1, activate: 0});
        assert.equal(finalCheck.session.readiness, "blocked");
        assert.equal(finalCheck.maintenance.active, true);
    });

    it("does not activate after a partial-chain failure and preserves the last confirmed head under maintenance", async () => {
        const session = new GateSession({current: A, attempts: []});
        const partial = runtime({
            session,
            apply: async (requested: DeploymentBindingInfo) => {
                session.current = {...B};
                session.attempts = [{
                    attemptId: "attempt-partial",
                    deploymentId: requested.deploymentId,
                    installationId: requested.installationId,
                    planHash: requested.planHash,
                    state: "failed",
                    confirmedTarget: B,
                    problems: [issue("migration.checkFailed")],
                }];
                return {ok: false, problems: [issue("migration.checkFailed")]};
            },
        });
        const result = await runDeploymentPipeline(binding(), partial.runtime);
        assert.equal(result.ok, false);
        assert.equal(session.current.releaseId, "B");
        assert.equal(partial.counters.activate, 0);
        assert.equal(partial.maintenance.active, true);
    });

    it("restarts between apply and gate by reading durable journal state, including the empty-plan case, without executing apply again", async () => {
        const empty = binding({from: B, to: B});
        const session = new GateSession({
            verification: verification(empty),
            current: B,
            attempts: [succeededAttempt(empty, B)],
        });
        let finalChecks = 0;
        const result = await checkDeploymentReady(empty, {
            session,
            journal,
            maintenance: {isActive: async () => true},
            finalChecks: async () => { finalChecks += 1; return {ok: true, value: true}; },
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.value.binding.candidateApplicationHash, empty.candidateApplicationHash);
        assert.equal(result.value.applyAttemptId, "attempt-1");
        assert.equal(result.value.confirmedTarget.releaseHash, B.releaseHash);
        assert.equal(finalChecks, 1, "empty plans still revalidate target checks before activation");
        assert.equal(session.readiness, "ready");
        assert.ok(session.calls.some(one => /verification_run/i.test(one.text)), "gate must reread durable verification after restart");
        assert.ok(session.calls.some(one => /execution_attempt/i.test(one.text)), "gate must reread durable apply outcome after restart");
        assert.ok(session.calls.some(one => /installation/i.test(one.text)), "gate must reread the durable head after restart");
    });

    it("activates the exact candidate once only after ready, consumes readiness, then leaves maintenance", async () => {
        const success = runtime();
        const result = await runDeploymentPipeline(binding(), success.runtime);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.value.binding.candidateApplicationHash, "c".repeat(64));
        assert.deepEqual(success.counters, {apply: 1, activate: 1});
        assert.equal(success.session.readiness, "consumed");
        assert.equal(success.maintenance.active, false);

        const readyIndex = success.events.indexOf("readiness:ready");
        const activateIndex = success.events.indexOf(`activate:${"c".repeat(64)}`);
        const consumedIndex = success.events.indexOf("readiness:consumed");
        const maintenanceIndex = success.events.indexOf("maintenance:complete:maintenance-1");
        assert.ok(readyIndex >= 0 && readyIndex < activateIndex, "activation must happen only after durable ready");
        assert.ok(activateIndex < consumedIndex, "readiness is consumed only after activation succeeds");
        assert.ok(consumedIndex < maintenanceIndex, "maintenance ends only after readiness consumption");
    });

    it("keeps target head, maintenance and unconsumed readiness when application activation fails", async () => {
        const failedActivation = runtime({
            activate: async () => ({ok: false, problems: [issue("deployment.activationFailed")]}),
        });
        const result = await runDeploymentPipeline(binding(), failedActivation.runtime);
        assert.equal(result.ok, false);
        assert.equal(failedActivation.session.current.releaseHash, B.releaseHash);
        assert.equal(failedActivation.session.readiness, "ready", "failed activation must not consume readiness");
        assert.equal(failedActivation.maintenance.active, true);
        assert.deepEqual(failedActivation.counters, {apply: 1, activate: 1});
        assert.equal(failedActivation.events.some(one => one === "readiness:consumed"), false);
        assert.equal(failedActivation.events.some(one => one.startsWith("maintenance:complete:")), false);

        const reevaluated = await checkDeploymentReady(binding(), {
            session: failedActivation.session,
            journal,
            maintenance: {isActive: (id: string, installationId: string) => failedActivation.maintenance.isActive(id, installationId)},
            finalChecks: async () => ({ok: true, value: true}),
        });
        assert.equal(reevaluated.ok, true, "resume re-evaluates the gate from journal state instead of replaying SQL");
    });
});

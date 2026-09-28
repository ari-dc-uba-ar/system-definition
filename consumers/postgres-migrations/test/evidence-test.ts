import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
import {bootstrapJournal, type JournalConfig} from "../src/journal";
import type {PgSession, SqlParameter} from "../src/pg-schema";
import {
    checkApplyEligibility,
    deriveVerificationStatus,
    readLatestVerification,
    recordVerification,
    type DeploymentBindingInfo,
    type VerificationCheckInfo,
    type VerificationRunDraft,
    type VerificationRunInfo,
} from "../src/evidence";

const journal: JournalConfig = {schema: "sd_journal"};
const A: ReleaseRefInfo = {systemId: "aida", releaseId: "A", releaseHash: "a".repeat(64)};
const B: ReleaseRefInfo = {systemId: "aida", releaseId: "B", releaseHash: "b".repeat(64)};

type QueryResult = {
    rows: readonly Readonly<Record<string, unknown>>[];
    rowCount: number | null;
};
type QueryCall = {text: string; values: readonly SqlParameter[]};

class ScriptedSession implements PgSession {
    readonly calls: QueryCall[] = [];
    closed = false;
    constructor(private readonly responder: (text: string, values: readonly SqlParameter[]) => QueryResult) {}
    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        this.calls.push({text, values});
        return this.responder(text, values);
    }
    async close(): Promise<void> { this.closed = true; }
}

function problem(messageKey: string): Problem {
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

function check(
    kind: VerificationCheckInfo["kind"],
    status: VerificationCheckInfo["status"] = "passed",
): VerificationCheckInfo {
    return {
        id: "check-" + kind,
        kind,
        status,
        reportId: "report-" + kind,
        problems: status === "failed" ? [problem("migration.checkFailed")] : [],
    };
}

function baseChecks(): VerificationCheckInfo[] {
    return [check("artifacts"), check("environment"), check("structure"), check("data")];
}

function allUpgradeChecks(): VerificationCheckInfo[] {
    return [...baseChecks(), check("rehearsal")];
}

function run(
    ordinal: number,
    bindingValue: DeploymentBindingInfo = binding(),
    checks: readonly VerificationCheckInfo[] = allUpgradeChecks(),
    status: VerificationRunInfo["status"] = "passed",
    createdAt = "2026-09-28T12:00:00.000Z",
): VerificationRunInfo {
    return {
        verificationId: "verification-" + ordinal,
        ordinal,
        binding: bindingValue,
        status,
        checks,
        createdAt,
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

function sessionReturning(value: VerificationRunInfo | null): ScriptedSession {
    return new ScriptedSession(text => {
        if (/verification_run/i.test(text) && /select/i.test(text)) {
            return value === null ? {rows: [], rowCount: 0} : {rows: [verificationRow(value)], rowCount: 1};
        }
        return {rows: [], rowCount: 0};
    });
}

async function eligibleWith(value: VerificationRunInfo | null, requested = binding()): Promise<ValidationResult<VerificationRunInfo>> {
    return checkApplyEligibility(requested, {session: sessionReturning(value), journal});
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

describe("deployment-bound verification evidence", () => {
    it("blocks missing evidence and recomputes required coverage instead of trusting a claimed passed status", async () => {
        assert.equal(firstKey(await eligibleWith(null)), "deployment.verificationMissing");

        const claimedPassedButIncomplete = run(1, binding(), baseChecks(), "passed");
        const incomplete = await eligibleWith(claimedPassedButIncomplete);
        assert.equal(incomplete.ok, false);
        assert.equal(firstKey(incomplete), "deployment.verificationIncomplete");

        const tampered = run(1, binding({candidateApplicationHash: "tampered"}), allUpgradeChecks(), "passed");
        const altered = await eligibleWith(tampered);
        assert.equal(altered.ok, false);
        assert.equal(firstKey(altered), "deployment.evidenceMismatch");
    });

    it("requires an exact candidate, installation, plan and configuration binding", async () => {
        const exact = binding();
        const passed = run(1, exact);
        assert.equal((await eligibleWith(passed, exact)).ok, true);

        const mismatches: DeploymentBindingInfo[] = [
            binding({candidateApplicationHash: "f".repeat(64)}),
            binding({installationId: "installation-2"}),
            binding({planHash: "1".repeat(64)}),
            binding({configurationHash: "2".repeat(64)}),
        ];
        for (const requested of mismatches) {
            const result = await eligibleWith(passed, requested);
            assert.equal(result.ok, false);
            assert.equal(firstKey(result), "deployment.evidenceMismatch");
        }
    });

    it("orders by durable ordinal, so a newer incomplete or failed run invalidates an older passed result", async () => {
        const newerIncomplete = run(2, binding(), [check("artifacts")], "passed", "2026-09-27T12:00:00.000Z");
        const session = sessionReturning(newerIncomplete);
        const latest = await readLatestVerification(session, journal, "deployment-1");
        assert.equal(latest.ok, true);
        if (!latest.ok || latest.value === null) return;
        assert.equal(latest.value.ordinal, 2);
        const select = session.calls.find(one => /verification_run/i.test(one.text) && /select/i.test(one.text));
        if (select === undefined) throw new Error("latest verification query was not issued");
        assert.match(select.text, /order\s+by[\s\S]*ordinal[\s\S]*desc/i);
        assert.match(select.text, /limit\s+1/i);
        assert.doesNotMatch(select.text, /order\s+by[\s\S]*created_at/i);

        assert.equal(firstKey(await eligibleWith(newerIncomplete)), "deployment.verificationIncomplete");

        const failedChecks = allUpgradeChecks();
        failedChecks[2] = check("structure", "failed");
        const newerFailed = run(3, binding(), failedChecks, "passed", "2026-09-26T12:00:00.000Z");
        assert.equal(firstKey(await eligibleWith(newerFailed)), "deployment.verificationFailed");
    });

    it("assigns the run ordinal durably and derives status from coverage when recording", async () => {
        const boot = new ScriptedSession(() => ({rows: [], rowCount: 0}));
        const bootstrapped = await bootstrapJournal(boot, journal);
        assert.equal(bootstrapped.ok, true);
        assert.ok(boot.calls.some(one => /create\s+table[\s\S]*verification_run/i.test(one.text)),
            "journal bootstrap must own the durable verification table");

        const checks = allUpgradeChecks();
        checks[1] = check("environment", "failed");
        const expected = run(7, binding(), checks, "failed");
        const session = new ScriptedSession(text => {
            if (/verification_run/i.test(text) && /insert/i.test(text)) {
                return {rows: [verificationRow(expected)], rowCount: 1};
            }
            return {rows: [], rowCount: 0};
        });
        const draft: VerificationRunDraft = {
            verificationId: expected.verificationId,
            binding: expected.binding,
            checks,
            createdAt: expected.createdAt,
        };
        const recorded = await recordVerification(session, journal, draft);
        assert.equal(recorded.ok, true);
        if (!recorded.ok) return;
        assert.equal(recorded.value.ordinal, 7, "ordinal is assigned by the durable store, not by the caller");
        assert.equal(recorded.value.status, "failed");
        assert.equal(deriveVerificationStatus(draft.binding, draft.checks), "failed");
        const insert = session.calls.find(one => /verification_run/i.test(one.text) && /insert/i.test(one.text));
        if (insert === undefined) throw new Error("verification insert was not issued");
        assert.ok(insert.values.includes("failed"), "derived status must be persisted");
    });

    it("distinguishes install from=null from upgrade and requires rehearsal only for production upgrade", async () => {
        const install = binding({operation: "install", from: null});
        const upgrade = binding();
        const checksWithoutRehearsal = baseChecks();
        assert.equal(deriveVerificationStatus(install, checksWithoutRehearsal), "passed");
        assert.equal(deriveVerificationStatus(upgrade, checksWithoutRehearsal), "incomplete");
        assert.equal(deriveVerificationStatus(upgrade, allUpgradeChecks()), "passed");

        const installRun = run(1, install, checksWithoutRehearsal, "passed");
        const installEligibility = await eligibleWith(installRun, install);
        assert.equal(installEligibility.ok, true);
        if (installEligibility.ok) assert.equal(installEligibility.value.binding.from, null);
    });
});

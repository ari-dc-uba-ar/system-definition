import {strict as assert} from "node:assert";
import type {
    MigrationInfo,
    Problem,
    PublishedMigrationInfo,
    ReleaseRefInfo,
} from "system-definition";
import {describe, it} from "mocha";
import type {PgSession, SqlParameter} from "../src/pg-schema";
import {reconcileCommitOutcome} from "../src/recovery";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const migrationHashAB = "d".repeat(64);
const migrationHashBC = "e".repeat(64);
const planHash = "f".repeat(64);

const A: ReleaseRefInfo = {systemId: "aida", releaseId: "A", releaseHash: hashA};
const B: ReleaseRefInfo = {systemId: "aida", releaseId: "B", releaseHash: hashB};
const C: ReleaseRefInfo = {systemId: "aida", releaseId: "C", releaseHash: hashC};

function migration(id: string, from: ReleaseRefInfo, to: ReleaseRefInfo): MigrationInfo {
    return {
        id,
        description: "",
        from,
        to,
        before: [],
        steps: [],
        after: [],
    };
}

const AB: PublishedMigrationInfo = {migration: migration("A-B", A, B), migrationHash: migrationHashAB};
const BC: PublishedMigrationInfo = {migration: migration("B-C", B, C), migrationHash: migrationHashBC};

const journal = {schema: "sd_journal"} as const;
const scope = {systemId: "aida", schemas: ["app"]} as const;
const context = {journal, scope} as const;

type QueryResult = Awaited<ReturnType<PgSession["query"]>>;
type QueryCall = {text: string; values: readonly SqlParameter[]};

type DurableAttempt = {
    attemptId: string;
    state: "running" | "failed" | "unknown" | "succeeded";
    confirmedTarget: ReleaseRefInfo | null;
};

type DurableHistory = {
    ordinal: number;
    migrationId: string;
    migrationHash: string;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
};

function installationRow(current: ReleaseRefInfo): Readonly<Record<string, unknown>> {
    return {
        installation_id: "installation-1",
        system_id: "aida",
        schemas: ["app"],
        baseline_system_id: A.systemId,
        baseline_release_id: A.releaseId,
        baseline_release_hash: A.releaseHash,
        current_system_id: current.systemId,
        current_release_id: current.releaseId,
        current_release_hash: current.releaseHash,
        journal_format_version: 1,
    };
}

function historyRow(one: DurableHistory): Readonly<Record<string, unknown>> {
    return {
        installation_id: "installation-1",
        ordinal: one.ordinal,
        migration_id: one.migrationId,
        migration_hash: one.migrationHash,
        from_system_id: one.from.systemId,
        from_release_id: one.from.releaseId,
        from_release_hash: one.from.releaseHash,
        to_system_id: one.to.systemId,
        to_release_id: one.to.releaseId,
        to_release_hash: one.to.releaseHash,
        committed_at: "2026-09-28T18:00:00.000Z",
    };
}

function attemptRow(attempt: DurableAttempt): Readonly<Record<string, unknown>> {
    return {
        attempt_id: attempt.attemptId,
        deployment_id: "deployment-1",
        installation_id: "installation-1",
        plan_hash: planHash,
        state: attempt.state,
        confirmed_target_system_id: attempt.confirmedTarget?.systemId ?? null,
        confirmed_target_release_id: attempt.confirmedTarget?.releaseId ?? null,
        confirmed_target_release_hash: attempt.confirmedTarget?.releaseHash ?? null,
        problems: [],
    };
}

class RecoverySession implements PgSession {
    readonly calls: QueryCall[] = [];
    private attempt: DurableAttempt;

    constructor(
        readonly current: ReleaseRefInfo,
        readonly history: readonly DurableHistory[],
        attemptId: string,
    ) {
        this.attempt = {attemptId, state: "unknown", confirmedTarget: null};
    }

    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        this.calls.push({text, values});
        const normalized = text.replace(/\s+/g, " ").trim();
        if (/FROM\s+"?sd_journal"?\.execution_attempt/i.test(normalized)) {
            return {rows: [attemptRow(this.attempt)], rowCount: 1};
        }
        if (/FROM\s+"?sd_journal"?\.installation/i.test(normalized)) {
            return {rows: [installationRow(this.current)], rowCount: 1};
        }
        if (/FROM\s+"?sd_journal"?\.migration_history/i.test(normalized)) {
            return {rows: this.history.map(historyRow), rowCount: this.history.length};
        }
        if (/UPDATE\s+"?sd_journal"?\.execution_attempt/i.test(normalized)) {
            const state = values[1];
            assert.ok(state === "failed" || state === "succeeded");
            const confirmed = state === "succeeded" ? this.current : null;
            this.attempt = {attemptId: this.attempt.attemptId, state, confirmedTarget: confirmed};
            return {rows: [attemptRow(this.attempt)], rowCount: 1};
        }
        throw new Error("unexpected SQL in T12 recovery fixture: " + normalized.slice(0, 160));
    }

    async close(): Promise<void> {}
}

function mutatingApplicationSql(call: QueryCall): boolean {
    return /\b(UPDATE|INSERT|DELETE|ALTER|CREATE|DROP|TRUNCATE)\s+(?!"?sd_journal"?\.)/i.test(call.text);
}

describe("commit outcome recovery", () => {
    it("uses a fresh journal read after a lost COMMIT response and never repeats already-confirmed SQL", async () => {
        const freshRunnerSession = new RecoverySession(B, [{
            ordinal: 1,
            migrationId: "A-B",
            migrationHash: migrationHashAB,
            from: A,
            to: B,
        }], "attempt-ab");

        const recovered = await reconcileCommitOutcome(freshRunnerSession, "attempt-ab", AB, context);
        assert.equal(recovered.ok, true);
        if (!recovered.ok) return;
        assert.equal(recovered.value.state, "succeeded");
        assert.deepEqual(recovered.value.confirmedHead, B);
        assert.equal(recovered.value.retryAllowed, false);
        assert.equal(recovered.value.deploymentBlocked, false);
        assert.equal(recovered.value.keepMaintenance, true);
        assert.deepEqual(recovered.value.problems, []);
        assert.equal(freshRunnerSession.calls.some(mutatingApplicationSql), false, "recovery must not replay migration SQL");
    });

    it("classifies an uncommitted attempt as failed and permits only an explicit retry from the proven origin", async () => {
        const freshRunnerSession = new RecoverySession(A, [], "attempt-ab");
        const recovered = await reconcileCommitOutcome(freshRunnerSession, "attempt-ab", AB, context);
        assert.equal(recovered.ok, true);
        if (!recovered.ok) return;
        assert.equal(recovered.value.state, "failed");
        assert.deepEqual(recovered.value.confirmedHead, A);
        assert.equal(recovered.value.retryAllowed, true);
        assert.equal(recovered.value.deploymentBlocked, true);
        assert.equal(recovered.value.keepMaintenance, true);
        assert.equal(freshRunnerSession.calls.some(mutatingApplicationSql), false);
    });

    it("keeps an unprovable origin/destination unknown and blocks both retry and deployment", async () => {
        const freshRunnerSession = new RecoverySession(C, [{
            ordinal: 1,
            migrationId: "A-C-other",
            migrationHash: "9".repeat(64),
            from: A,
            to: C,
        }], "attempt-ab");
        const recovered = await reconcileCommitOutcome(freshRunnerSession, "attempt-ab", AB, context);
        assert.equal(recovered.ok, true);
        if (!recovered.ok) return;
        assert.equal(recovered.value.state, "unknown");
        assert.deepEqual(recovered.value.confirmedHead, C);
        assert.equal(recovered.value.retryAllowed, false);
        assert.equal(recovered.value.deploymentBlocked, true);
        assert.equal(recovered.value.keepMaintenance, true);
        assert.ok(recovered.value.problems.some((one: Problem) => one.messageKey === "migration.unknownCommitOutcome"));
        assert.equal(freshRunnerSession.calls.some(mutatingApplicationSql), false);
    });

    it("reconciles A→B as succeeded and B→C as failed with B remaining the confirmed head", async () => {
        const durableHistory: readonly DurableHistory[] = [{
            ordinal: 1,
            migrationId: "A-B",
            migrationHash: migrationHashAB,
            from: A,
            to: B,
        }];

        const afterRestartForAB = new RecoverySession(B, durableHistory, "attempt-ab");
        const ab = await reconcileCommitOutcome(afterRestartForAB, "attempt-ab", AB, context);
        assert.equal(ab.ok, true);
        if (!ab.ok) return;
        assert.equal(ab.value.state, "succeeded");
        assert.deepEqual(ab.value.confirmedHead, B);

        const afterRestartForBC = new RecoverySession(B, durableHistory, "attempt-bc");
        const bc = await reconcileCommitOutcome(afterRestartForBC, "attempt-bc", BC, context);
        assert.equal(bc.ok, true);
        if (!bc.ok) return;
        assert.equal(bc.value.state, "failed");
        assert.deepEqual(bc.value.confirmedHead, B);
        assert.equal(bc.value.retryAllowed, true);
        assert.equal(bc.value.deploymentBlocked, true);
        assert.equal(bc.value.keepMaintenance, true, "maintenance stays active after the failed B→C segment");
    });
});

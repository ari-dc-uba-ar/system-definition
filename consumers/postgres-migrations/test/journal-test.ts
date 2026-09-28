import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
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
    type AttemptInfo,
    type InstallationInfo,
    type InstallationScope,
    type JournalConfig,
    type MigrationHistoryInfo,
    type PgSessionFactory,
} from "../src/journal";
import type {PgSession, SqlParameter} from "../src/pg-schema";

const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const MIGRATION_HASH = "d".repeat(64);
const PLAN_HASH = "e".repeat(64);
const journal: JournalConfig = {schema: "sd_journal"};
const scope: InstallationScope = {systemId: "aida", schemas: ["app"]};

function release(releaseId: string, releaseHash: string): ReleaseRefInfo {
    return {systemId: "aida", releaseId, releaseHash};
}

const B = release("B", HASH_B);
const C = release("C", HASH_C);

function blocking(messageKey: string): Problem {
    return {field: null, messageKey, severity: "blocking", details: {}};
}

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

    async close(): Promise<void> {
        this.closed = true;
    }
}

function installationRow(current: ReleaseRefInfo = B, journalFormatVersion = 1): Readonly<Record<string, unknown>> {
    return {
        installation_id: "installation-1",
        system_id: "aida",
        schemas: ["app"],
        baseline_system_id: B.systemId,
        baseline_release_id: B.releaseId,
        baseline_release_hash: B.releaseHash,
        current_system_id: current.systemId,
        current_release_id: current.releaseId,
        current_release_hash: current.releaseHash,
        journal_format_version: journalFormatVersion,
    };
}

function historyRow(from: ReleaseRefInfo = B, to: ReleaseRefInfo = C, ordinal = 1): Readonly<Record<string, unknown>> {
    return {
        installation_id: "installation-1",
        ordinal,
        migration_id: "B-C",
        migration_hash: MIGRATION_HASH,
        from_system_id: from.systemId,
        from_release_id: from.releaseId,
        from_release_hash: from.releaseHash,
        to_system_id: to.systemId,
        to_release_id: to.releaseId,
        to_release_hash: to.releaseHash,
        committed_at: "2026-09-28T12:00:00.000Z",
    };
}

function attemptRow(state: AttemptInfo["state"] = "running"): Readonly<Record<string, unknown>> {
    return {
        attempt_id: "attempt-1",
        deployment_id: "deploy-1",
        installation_id: "installation-1",
        plan_hash: PLAN_HASH,
        state,
        confirmed_target_system_id: null,
        confirmed_target_release_id: null,
        confirmed_target_release_hash: null,
        problems: state === "failed" ? [blocking("migration.stepFailed")] : [],
    };
}

function success<T>(value: T): ValidationResult<T> {
    return {ok: true, value};
}

describe("migration journal and coordination", function(){
    it("bootstraps a separate versioned journal and records a fresh B install as baseline B with no fictional history", async function(){
        const session = new ScriptedSession((text) => {
            if (/insert\s+into[\s\S]*installation/i.test(text)) return {rows: [installationRow()], rowCount: 1};
            if (/from[\s\S]*migration_history/i.test(text)) return {rows: [], rowCount: 0};
            return {rows: [], rowCount: 0};
        });

        const bootstrapped = await bootstrapJournal(session, journal);
        assert.equal(bootstrapped.ok, true);
        assert.ok(session.calls.some(one => /create\s+schema/i.test(one.text) && /sd_journal/i.test(one.text)));
        assert.ok(session.calls.some(one => /journal_format_version/i.test(one.text)));

        const installed = await installBaseline(session, journal, {
            installationId: "installation-1",
            scope,
            baseline: B,
        });
        assert.equal(installed.ok, true);
        if (!installed.ok) return;
        assert.deepEqual(installed.value.baseline, B);
        assert.deepEqual(installed.value.current, B);
        assert.equal(installed.value.journalFormatVersion, 1);

        const history = await readHistory(session, journal, "installation-1");
        assert.deepEqual(history, {ok: true, value: []});

        const collidingJournal = await installBaseline(session, {schema: "app"}, {
            installationId: "installation-2",
            scope,
            baseline: B,
        });
        assert.equal(collidingJournal.ok, false);
    });

    it("decodes the durable head/history strictly and rejects unknown journal versions or non-contiguous history", async function(){
        const good = new ScriptedSession((text) => /migration_history/i.test(text)
            ? {rows: [historyRow()], rowCount: 1}
            : {rows: [installationRow(C)], rowCount: 1});
        const installation = await readInstallation(good, journal, scope);
        assert.equal(installation.ok, true);
        if (!installation.ok || installation.value === null) return;
        const history = await readHistory(good, journal, installation.value.installationId);
        assert.equal(history.ok, true);
        if (!history.ok) return;
        const verified = verifyHistory(installation.value, history.value);
        assert.equal(verified.ok, true);
        if (verified.ok) assert.equal(verified.value[0].ordinal, 1);

        const wrongVersion = new ScriptedSession(() => ({rows: [installationRow(B, 2)], rowCount: 1}));
        const decoded = await readInstallation(wrongVersion, journal, scope);
        assert.equal(decoded.ok, false);

        const gap: MigrationHistoryInfo = {
            installationId: "installation-1",
            ordinal: 2,
            migrationId: "B-C",
            migrationHash: MIGRATION_HASH,
            from: B,
            to: C,
            committedAt: "2026-09-28T12:00:00.000Z",
        };
        const invalidHistory = verifyHistory({...installation.value, current: C}, [gap]);
        assert.equal(invalidHistory.ok, false);
    });

    it("appends committed history and advances head on the caller session without opening or committing a hidden transaction", async function(){
        const session = new ScriptedSession((text) => {
            if (/migration_history/i.test(text) && /installation/i.test(text)) return {rows: [installationRow(C)], rowCount: 1};
            return {rows: [], rowCount: 0};
        });
        const history: MigrationHistoryInfo = {
            installationId: "installation-1",
            ordinal: 1,
            migrationId: "B-C",
            migrationHash: MIGRATION_HASH,
            from: B,
            to: C,
            committedAt: "2026-09-28T12:00:00.000Z",
        };

        const appended = await appendCommittedMigration(session, journal, B, history);
        assert.equal(appended.ok, true);
        if (!appended.ok) return;
        assert.deepEqual(appended.value.current, C);
        assert.equal(session.calls.length, 1);
        assert.match(session.calls[0].text, /migration_history/i);
        assert.match(session.calls[0].text, /installation/i);
        assert.doesNotMatch(session.calls[0].text, /\bBEGIN\b|\bCOMMIT\b/i);
        assert.ok(session.calls[0].values.includes(B.releaseHash));
        assert.ok(session.calls[0].values.includes(C.releaseHash));
    });

    it("records attempts explicitly, so a failed attempt can be persisted only after the caller has rolled back", async function(){
        const events: string[] = [];
        const session = new ScriptedSession((text) => {
            if (/rollback/i.test(text)) {
                events.push("rollback");
                return {rows: [], rowCount: null};
            }
            if (/insert\s+into[\s\S]*execution_attempt/i.test(text)) {
                events.push("start");
                return {rows: [attemptRow("running")], rowCount: 1};
            }
            if (/update[\s\S]*execution_attempt/i.test(text)) {
                events.push("finish");
                return {rows: [attemptRow("failed")], rowCount: 1};
            }
            return {rows: [], rowCount: 0};
        });

        const started = await startAttempt(session, journal, {
            attemptId: "attempt-1",
            deploymentId: "deploy-1",
            installationId: "installation-1",
            planHash: PLAN_HASH,
        });
        assert.equal(started.ok, true);
        await session.query("ROLLBACK", []);
        const finished = await finishAttempt(session, journal, "attempt-1", {
            state: "failed",
            confirmedTarget: null,
            problems: [blocking("migration.stepFailed")],
        });
        assert.equal(finished.ok, true);
        if (finished.ok) assert.equal(finished.value.state, "failed");
        assert.deepEqual(events, ["start", "rollback", "finish"]);
    });

    it("serializes migrators with a session advisory lock and always unlocks/closes the dedicated connection", async function(){
        let held = false;
        let releaseFirst!: () => void;
        const gate = new Promise<void>(resolve => { releaseFirst = resolve; });

        class LockSession implements PgSession {
            closed = false;
            readonly calls: QueryCall[] = [];
            async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
                this.calls.push({text, values});
                if (/pg_try_advisory_lock/i.test(text)) {
                    if (held) return {rows: [{locked: false}], rowCount: 1};
                    held = true;
                    return {rows: [{locked: true}], rowCount: 1};
                }
                if (/pg_advisory_unlock/i.test(text)) {
                    held = false;
                    return {rows: [{unlocked: true}], rowCount: 1};
                }
                return {rows: [], rowCount: 0};
            }
            async close(): Promise<void> { this.closed = true; }
        }

        const sessions: LockSession[] = [];
        const factory: PgSessionFactory = {
            async openTarget(): Promise<PgSession> {
                const session = new LockSession();
                sessions.push(session);
                return session;
            },
        };

        let firstEntered = false;
        const first = withMigrationLock(factory, scope, 1000, async () => {
            firstEntered = true;
            await gate;
            return success("first");
        });
        while (!firstEntered) await new Promise(resolve => setTimeout(resolve, 0));

        let secondRan = false;
        const second = await withMigrationLock(factory, scope, 1, async () => {
            secondRan = true;
            return success("second");
        });
        assert.equal(second.ok, false);
        assert.equal(secondRan, false);
        assert.equal(sessions[1].closed, true);

        releaseFirst();
        const firstResult = await first;
        assert.deepEqual(firstResult, success("first"));
        assert.equal(sessions[0].closed, true);
        assert.ok(sessions[0].calls.some(one => /pg_advisory_unlock/i.test(one.text)));
        assert.equal(held, false);

        const invalidTimeout = await withMigrationLock(factory, scope, 0, async () => success(true));
        assert.equal(invalidTimeout.ok, false);
        assert.equal(sessions.length, 2, "invalid options must fail before opening a connection");
    });
});

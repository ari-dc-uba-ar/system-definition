import {strict as assert} from "node:assert";
import {
    type MigrationPathInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {MigrationExecutionContext, ReleaseExecutionState} from "../src/execute-migration";
import type {InstallationScope, JournalConfig} from "../src/journal";
import type {PgSchemaInfo, PgSession, ResolvedSqlResource, SqlParameter} from "../src/pg-schema";
import {
    checkRehearsalRequirement,
    rehearseUpgrade,
    type RehearsalCopyRef,
    type RehearsalHandle,
    type RehearsalProvider,
    type RehearsalReportInfo,
    type RehearsalRequirement,
} from "../src/rehearsal";

type QueryResult = Awaited<ReturnType<PgSession["query"]>>;

const A: ReleaseRefInfo = {systemId: "rehearsal-system", releaseId: "A", releaseHash: "a".repeat(64)};
const B: ReleaseRefInfo = {systemId: "rehearsal-system", releaseId: "B", releaseHash: "b".repeat(64)};
const C: ReleaseRefInfo = {systemId: "rehearsal-system", releaseId: "C", releaseHash: "c".repeat(64)};
const journal: JournalConfig = {schema: "sd_journal"};
const scope: InstallationScope = {systemId: "rehearsal-system", schemas: ["app"]};
const emptySchema: PgSchemaInfo = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []};

function resource(name: string, kind: ResourceRefInfo["kind"], char: string): ResourceRefInfo {
    return {name, kind, contentHash: char.repeat(64)};
}
const beforeAB = resource("before-ab", "check", "3");
const stepAB = resource("step-ab", "sql", "4");
const afterAB = resource("after-ab", "check", "5");
const invariantB = resource("invariant-b", "check", "6");
const beforeBC = resource("before-bc", "check", "7");
const stepBC = resource("step-bc", "sql", "8");
const afterBC = resource("after-bc", "check", "9");
const invariantC = resource("invariant-c", "check", "0");

function published(
    id: string,
    from: ReleaseRefInfo,
    to: ReleaseRefInfo,
    migrationHash: string,
    before: ResourceRefInfo,
    step: ResourceRefInfo,
    after: ResourceRefInfo,
): PublishedMigrationInfo {
    return {
        migration: {id, from, to, description: "rehearsal fixture", before: [before], steps: [{id: "step", run: step}], after: [after]},
        migrationHash,
    };
}
const AB = published("A-B", A, B, "1".repeat(64), beforeAB, stepAB, afterAB);
const BC = published("B-C", B, C, "2".repeat(64), beforeBC, stepBC, afterBC);
const path: MigrationPathInfo = {from: A, to: C, migrations: [AB, BC]};

const resources: Readonly<Record<string, ResolvedSqlResource>> = Object.fromEntries([
    beforeAB, stepAB, afterAB, invariantB, beforeBC, stepBC, afterBC, invariantC,
].map(ref => [ref.name, {
    ref,
    text: ref.kind === "check" ? `SELECT true AS ok /* ${ref.name} */` : `SELECT 1 /* ${ref.name} */`,
}]));

function state(invariantChecks: readonly ResourceRefInfo[] = []): ReleaseExecutionState {
    return {expectedSchema: emptySchema, inspection: {schemas: ["app"], excluded: []}, managedData: [], invariantChecks};
}
function context(migration: PublishedMigrationInfo): MigrationExecutionContext {
    return {
        journal,
        scope,
        resources,
        from: state(),
        to: state(migration.migration.to.releaseId === "B" ? [invariantB] : [invariantC]),
        options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
        now: () => migration.migration.to.releaseId === "B"
            ? "2026-09-28T20:00:00.000Z"
            : "2026-09-28T20:01:00.000Z",
    };
}

function installationRow(current: ReleaseRefInfo): Readonly<Record<string, unknown>> {
    return {
        installation_id: "installation-1",
        system_id: scope.systemId,
        schemas: [...scope.schemas],
        baseline_system_id: A.systemId,
        baseline_release_id: A.releaseId,
        baseline_release_hash: A.releaseHash,
        current_system_id: current.systemId,
        current_release_id: current.releaseId,
        current_release_hash: current.releaseHash,
        journal_format_version: 1,
    };
}

class CopySession implements PgSession {
    readonly calls: {text: string; values: readonly SqlParameter[]}[] = [];
    readonly executedSteps: string[] = [];
    closed = false;
    current: ReleaseRefInfo;
    history: Readonly<Record<string, unknown>>[] = [];
    private snapshot: {current: ReleaseRefInfo; history: Readonly<Record<string, unknown>>[]} | null = null;

    constructor(current: ReleaseRefInfo) { this.current = current; }

    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        this.calls.push({text, values});
        const sql = text.trim();
        if (/^BEGIN$/i.test(sql)) {
            this.snapshot = {current: {...this.current}, history: this.history.map(one => ({...one}))};
            return {rows: [], rowCount: null};
        }
        if (/^ROLLBACK$/i.test(sql)) {
            if (this.snapshot !== null) {
                this.current = this.snapshot.current;
                this.history = this.snapshot.history;
            }
            this.snapshot = null;
            return {rows: [], rowCount: null};
        }
        if (/^COMMIT$/i.test(sql)) {
            this.snapshot = null;
            return {rows: [], rowCount: null};
        }
        if (/^SET LOCAL\s+/i.test(sql)) return {rows: [], rowCount: null};
        if (/\bFROM\s+"sd_journal"\.installation\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: [installationRow(this.current)], rowCount: 1};
        }
        if (/\bFROM\s+"sd_journal"\.migration_history\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: this.history, rowCount: this.history.length};
        }
        if (/pg_catalog/i.test(text)) return {rows: [], rowCount: 0};
        if (/SELECT true AS ok/i.test(sql)) return {rows: [{ok: true}], rowCount: 1};
        if (/SELECT 1 \/\* step-(ab|bc) \*\//i.test(sql)) {
            const marker = /step-(ab|bc)/i.exec(sql)?.[0] ?? "";
            this.executedSteps.push(marker.toLowerCase());
            return {rows: [{"?column?": 1}], rowCount: 1};
        }
        if (/WITH\s+current_installation/i.test(text)) {
            const to: ReleaseRefInfo = {systemId: String(values[7]), releaseId: String(values[8]), releaseHash: String(values[9])};
            const row = {
                installation_id: "installation-1",
                ordinal: Number(values[4]),
                migration_id: String(values[5]),
                migration_hash: String(values[6]),
                from_system_id: String(values[1]),
                from_release_id: String(values[2]),
                from_release_hash: String(values[3]),
                to_system_id: to.systemId,
                to_release_id: to.releaseId,
                to_release_hash: to.releaseHash,
                committed_at: String(values[10]),
            };
            this.history = [...this.history, row];
            this.current = to;
            return {rows: [installationRow(to)], rowCount: 1};
        }
        throw new Error("unexpected rehearsal SQL: " + sql.slice(0, 140));
    }

    async close(): Promise<void> { this.closed = true; }
}

class CopyProvider implements RehearsalProvider {
    readonly destroyed: string[] = [];
    readonly opened: RehearsalHandle[] = [];
    readonly owned = new Set<RehearsalHandle>();

    constructor(private readonly session: CopySession, private readonly own = true) {}

    async open(copy: RehearsalCopyRef): Promise<ValidationResult<RehearsalHandle>> {
        const handle: RehearsalHandle = {copy, session: this.session};
        this.opened.push(handle);
        if (this.own) this.owned.add(handle);
        return {ok: true, value: handle};
    }
    owns(handle: RehearsalHandle): boolean { return this.owned.has(handle); }
    async destroy(handle: RehearsalHandle): Promise<ValidationResult<true>> {
        assert.equal(this.owned.has(handle), true, "cleanup must be limited to the owned rehearsal environment");
        this.destroyed.push(handle.copy.copyId);
        this.owned.delete(handle);
        await handle.session.close();
        return {ok: true, value: true};
    }
}

function copyRef(source: ReleaseRefInfo = A): RehearsalCopyRef {
    return {
        copyId: "copy-prod-20260928",
        provenance: "backup:prod-20260928T120000Z",
        installationId: "installation-1",
        source,
        schemas: ["app"],
    };
}
function requirement(production = true): RehearsalRequirement {
    return {production, operation: "upgrade", from: A, to: C, scope, path};
}
function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

type ArtifactShape = {kind: "release" | "migration" | "resource"; id: string; contentHash: string};
type CheckShape = {id: string; contentHash: string};

function expectedArtifact(report: RehearsalReportInfo, kind: "release" | "migration" | "resource", id: string, hash: string): boolean {
    return report.artifacts.some((one: ArtifactShape) => one.kind === kind && one.id === id && one.contentHash === hash);
}

describe("identified-copy rehearsal", () => {
    it("runs the complete A→B→C segment on the identified copy and reports provenance, scope, artifacts and executed checks", async () => {
        const session = new CopySession(A);
        const provider = new CopyProvider(session);
        const result = await rehearseUpgrade({copy: copyRef(), path, journal, scope, resolveContext: context}, provider);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(session.executedSteps, ["step-ab", "step-bc"]);
        assert.equal(session.current.releaseId, "C");
        assert.equal(result.value.copy.provenance, "backup:prod-20260928T120000Z");
        assert.deepEqual(result.value.scope, scope);
        assert.deepEqual(result.value.migrations, [
            {id: "A-B", migrationHash: "1".repeat(64)},
            {id: "B-C", migrationHash: "2".repeat(64)},
        ]);
        assert.equal(expectedArtifact(result.value, "release", "A", A.releaseHash), true);
        assert.equal(expectedArtifact(result.value, "release", "C", C.releaseHash), true);
        assert.equal(expectedArtifact(result.value, "migration", "A-B", "1".repeat(64)), true);
        assert.equal(expectedArtifact(result.value, "resource", "step-bc", stepBC.contentHash), true);
        assert.deepEqual(result.value.checks.map((one: CheckShape) => one.id), ["before-ab", "after-ab", "invariant-b", "before-bc", "after-bc", "invariant-c"]);
        assert.equal(result.value.targetChecksRequired, true, "rehearsal must never claim to replace target checks under maintenance");
        assert.deepEqual(provider.destroyed, ["copy-prod-20260928"]);
    });

    it("rejects a copy whose durable source state does not match the declared source before any migration step", async () => {
        const session = new CopySession(B);
        const provider = new CopyProvider(session);
        const result = await rehearseUpgrade({copy: copyRef(A), path, journal, scope, resolveContext: context}, provider);
        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "deployment.evidenceMismatch");
        assert.deepEqual(session.executedSteps, []);
        assert.deepEqual(provider.destroyed, ["copy-prod-20260928"]);
    });

    it("blocks production upgrade when rehearsal is missing, failed or belongs to another source artifact, while a new install requires no backup", async () => {
        const session = new CopySession(A);
        const provider = new CopyProvider(session);
        const passed = await rehearseUpgrade({copy: copyRef(), path, journal, scope, resolveContext: context}, provider);
        assert.equal(passed.ok, true);
        if (!passed.ok) return;

        assert.equal(firstKey(checkRehearsalRequirement(requirement(), null)), "deployment.verificationIncomplete");
        const failed: ValidationResult<RehearsalReportInfo> = {
            ok: false,
            problems: [{field: null, messageKey: "migration.checkFailed", severity: "blocking", details: {copyId: "copy-prod-20260928"}}],
        };
        assert.equal(firstKey(checkRehearsalRequirement(requirement(), failed)), "deployment.verificationFailed");

        const wrongArtifact: ValidationResult<RehearsalReportInfo> = {
            ok: true,
            value: {...passed.value, copy: {...passed.value.copy, source: {...A, releaseHash: "f".repeat(64)}}},
        };
        assert.equal(firstKey(checkRehearsalRequirement(requirement(), wrongArtifact)), "deployment.evidenceMismatch");
        assert.equal(checkRehearsalRequirement(requirement(), passed).ok, true);

        const install: RehearsalRequirement = {production: true, operation: "install", from: null, to: C, scope, path: null};
        const installEligibility = checkRehearsalRequirement(install, null);
        assert.equal(installEligibility.ok, true, "a new install must not invent a nonexistent source backup");
        if (installEligibility.ok) assert.equal(installEligibility.value, null);
    });

    it("does not execute or clean a handle that the provider cannot prove it owns", async () => {
        const session = new CopySession(A);
        const provider = new CopyProvider(session, false);
        const result = await rehearseUpgrade({copy: copyRef(), path, journal, scope, resolveContext: context}, provider);
        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.invalidReference");
        assert.equal(session.calls.length, 0);
        assert.deepEqual(provider.destroyed, []);
    });
});

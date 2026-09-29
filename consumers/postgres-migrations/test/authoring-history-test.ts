import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ReleaseRefInfo, ValidationResult} from "system-definition";
import {
    checkHistoryHeadDrift,
    reconstructHistory,
    requireDesiredRelease,
} from "../src/authoring-history";
import type {PgObjectInfo, PgSchemaInfo, PgSession, SqlParameter} from "../src/pg-schema";
import type {ReleaseVerificationInput, ScratchHandle, ScratchProvider, UpgradeVerificationInput} from "../src/verify";
import {
    A,
    B,
    aidaEmailInspection,
    aidaEmailJournal,
    aidaEmailPath,
    aidaEmailPathWithoutAlter,
    aidaEmailPersistence,
    aidaEmailScope,
    aidaEmailSnapshotA,
    aidaEmailSnapshotB,
    aidaEmailStorage,
    executionContext,
    projectedA,
    projectedB,
} from "../fixtures/aida-email";

type QueryResult = {rows: readonly Readonly<Record<string, unknown>>[]; rowCount: number | null};

type ExpectedReconstructHistory = (
    input: Omit<UpgradeVerificationInput, "fixture">,
    scratch: ScratchProvider,
) => Promise<ValidationResult<PgSchemaInfo>>;
type ExpectedCheckHistoryHeadDrift = (
    historyHead: PgSchemaInfo,
    observed: PgSchemaInfo,
) => ValidationResult<true>;
type ExpectedRequireDesiredRelease = (
    desired: ReleaseVerificationInput | null,
) => ValidationResult<ReleaseVerificationInput>;

const reconstructHistoryContract: ExpectedReconstructHistory = reconstructHistory;
const checkHistoryHeadDriftContract: ExpectedCheckHistoryHeadDrift = checkHistoryHeadDrift;
const requireDesiredReleaseContract: ExpectedRequireDesiredRelease = requireDesiredRelease;
void reconstructHistoryContract;
void checkHistoryHeadDriftContract;
void requireDesiredReleaseContract;

function releaseRow(current: ReleaseRefInfo): Readonly<Record<string, unknown>> {
    return {
        installation_id: "history-scratch",
        system_id: "aida-email",
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

function catalogRows(schema: PgSchemaInfo): readonly Readonly<Record<string, unknown>>[] {
    return schema.objects.map((object): Readonly<Record<string, unknown>> => {
        const base = {
            object_kind: object.kind,
            schema_name: object.identity.schema,
            object_name: object.identity.name,
            parent_name: object.identity.parentName,
            signature: [...object.identity.signature],
            feature: null,
        };
        if (object.kind === "table") {
            return {...base, persistence: object.persistence === "permanent" ? "p" : object.persistence, relation_kind: object.relationKind};
        }
        if (object.kind === "column") {
            return {
                ...base,
                type_schema: object.type.schema,
                type_name: object.type.name,
                type_modifiers: [...object.type.modifiers],
                array_dimensions: object.type.arrayDimensions,
                collation: object.type.collation,
                nullable: object.nullable,
                default_expression: object.defaultExpression,
                identity_definition: object.identityDefinition,
                generated_definition: object.generatedDefinition,
            };
        }
        if (object.kind === "constraint") {
            return {
                ...base,
                constraint_kind: object.constraintKind,
                definition: object.definition,
                columns: [...object.columns],
                target_schema: object.target?.schema ?? null,
                target_name: object.target?.name ?? null,
                pairs: object.pairs.map(one => ({...one})),
                deferrable: object.deferrable,
                initially_deferred: object.initiallyDeferred,
                validated: object.validated,
                enforced: object.enforced,
            };
        }
        throw new Error("aida-email history fixture only projects table/column/constraint objects");
    });
}

function setEmailNullable(schema: PgSchemaInfo, nullable: boolean): PgSchemaInfo {
    return {
        ...schema,
        objects: schema.objects.map((object): PgObjectInfo => object.kind === "column"
            && object.identity.parentName === "alumnos" && object.identity.name === "email"
            ? {...object, nullable}
            : object),
    };
}

class HistoryScratchSession implements PgSession {
    readonly calls: {text: string; values: readonly SqlParameter[]}[] = [];
    closed = false;
    currentRelease: ReleaseRefInfo | null = null;
    history: Readonly<Record<string, unknown>>[] = [];
    currentSchema: PgSchemaInfo;
    private transactionSnapshot: {schema: PgSchemaInfo; release: ReleaseRefInfo | null; history: Readonly<Record<string, unknown>>[]} | null = null;

    constructor(readonly purpose: "clean-target" | "upgrade-source", initialSchema: PgSchemaInfo) {
        this.currentSchema = initialSchema;
    }

    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        this.calls.push({text, values});
        const sql = text.trim();
        if (/^CREATE TABLE\s+"app"\./i.test(sql)) return {rows: [], rowCount: null};
        if (/^ALTER TABLE\s+"app"\..+ADD CONSTRAINT/i.test(sql)) return {rows: [], rowCount: null};
        if (/^CREATE SCHEMA IF NOT EXISTS\s+"sd_journal"/i.test(sql)
            || /^CREATE TABLE IF NOT EXISTS\s+"sd_journal"/i.test(sql)) return {rows: [], rowCount: null};
        if (/^INSERT INTO\s+"sd_journal"\.installation/i.test(sql)) {
            const baseline: ReleaseRefInfo = {systemId: String(values[3]), releaseId: String(values[4]), releaseHash: String(values[5])};
            this.currentRelease = baseline;
            return {rows: [releaseRow(baseline)], rowCount: 1};
        }
        if (/\bFROM\s+"sd_journal"\.installation\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return this.currentRelease === null ? {rows: [], rowCount: 0} : {rows: [releaseRow(this.currentRelease)], rowCount: 1};
        }
        if (/\bFROM\s+"sd_journal"\.migration_history\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: this.history, rowCount: this.history.length};
        }
        if (/^BEGIN$/i.test(sql)) {
            this.transactionSnapshot = {
                schema: structuredClone(this.currentSchema),
                release: this.currentRelease === null ? null : {...this.currentRelease},
                history: this.history.map(one => ({...one})),
            };
            return {rows: [], rowCount: null};
        }
        if (/^ROLLBACK$/i.test(sql)) {
            if (this.transactionSnapshot !== null) {
                this.currentSchema = this.transactionSnapshot.schema;
                this.currentRelease = this.transactionSnapshot.release;
                this.history = this.transactionSnapshot.history;
            }
            this.transactionSnapshot = null;
            return {rows: [], rowCount: null};
        }
        if (/^COMMIT$/i.test(sql)) {
            this.transactionSnapshot = null;
            return {rows: [], rowCount: null};
        }
        if (/^SET LOCAL\s+/i.test(sql)) return {rows: [], rowCount: null};
        if (/SELECT NOT EXISTS/i.test(text)) return {rows: [{ok: true}], rowCount: 1};
        if (/^UPDATE app\.alumnos AS a SET email = c\.email/i.test(sql)) return {rows: [], rowCount: 0};
        if (/^ALTER TABLE app\.alumnos ALTER COLUMN email SET NOT NULL/i.test(sql)) {
            this.currentSchema = setEmailNullable(this.currentSchema, false);
            return {rows: [], rowCount: null};
        }
        if (/WITH\s+current_installation/i.test(text)) {
            this.currentRelease = B;
            this.history = [{
                installation_id: "history-scratch",
                ordinal: 1,
                migration_id: String(values[3]),
                migration_hash: String(values[4]),
                from_system_id: A.systemId,
                from_release_id: A.releaseId,
                from_release_hash: A.releaseHash,
                to_system_id: B.systemId,
                to_release_id: B.releaseId,
                to_release_hash: B.releaseHash,
                committed_at: String(values[11]),
            }];
            return {rows: [releaseRow(B)], rowCount: 1};
        }
        if (/pg_catalog/i.test(text)) return {rows: catalogRows(this.currentSchema), rowCount: null};
        throw new Error("unexpected history scratch SQL: " + sql.slice(0, 120));
    }

    async close(): Promise<void> { this.closed = true; }
}

class HistoryScratchProvider implements ScratchProvider {
    readonly created: ScratchHandle[] = [];
    readonly destroyed: string[] = [];
    readonly sessions: HistoryScratchSession[] = [];
    readonly owned = new Set<ScratchHandle>();

    async create(purpose: "clean-target" | "upgrade-source"): Promise<ValidationResult<ScratchHandle>> {
        const session = new HistoryScratchSession(purpose, purpose === "clean-target" ? projectedB() : projectedA());
        const handle: ScratchHandle = {id: "history-" + purpose + "-" + (this.created.length + 1), session};
        this.created.push(handle);
        this.sessions.push(session);
        this.owned.add(handle);
        return {ok: true, value: handle};
    }

    owns(handle: ScratchHandle): boolean { return this.owned.has(handle); }

    async destroy(handle: ScratchHandle): Promise<ValidationResult<true>> {
        assert.equal(this.owned.has(handle), true);
        this.destroyed.push(handle.id);
        this.owned.delete(handle);
        await handle.session.close();
        return {ok: true, value: true};
    }
}

function releaseInputA(): ReleaseVerificationInput {
    return {ref: A, snapshot: aidaEmailSnapshotA, persistence: aidaEmailPersistence, storage: aidaEmailStorage, inspection: aidaEmailInspection};
}

function releaseInputB(): ReleaseVerificationInput {
    return {ref: B, snapshot: aidaEmailSnapshotB, persistence: aidaEmailPersistence, storage: aidaEmailStorage, inspection: aidaEmailInspection};
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

describe("T18 history reconstruction and drift boundary", () => {
    it("reconstructs the recorded head by running the historical path through the owned T13 scratch harness", async () => {
        const scratch = new HistoryScratchProvider();
        const result = await reconstructHistory({
            source: releaseInputA(),
            target: releaseInputB(),
            path: aidaEmailPath,
            journal: aidaEmailJournal,
            scope: aidaEmailScope,
            resolveContext: executionContext,
        }, scratch);

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value, projectedB());
        const replay = scratch.sessions.find(one => one.purpose === "upgrade-source");
        assert.ok(replay);
        assert.equal(replay.calls.some(one => /^ALTER TABLE app\.alumnos ALTER COLUMN email SET NOT NULL/i.test(one.text.trim())), true);
        assert.deepEqual(scratch.destroyed.sort(), scratch.created.map(one => one.id).sort());
    });

    it("blocks authoring when real replay does not reach the schema recorded for historyHead", async () => {
        const scratch = new HistoryScratchProvider();
        const result = await reconstructHistory({
            source: releaseInputA(),
            target: releaseInputB(),
            path: aidaEmailPathWithoutAlter,
            journal: aidaEmailJournal,
            scope: aidaEmailScope,
            resolveContext: executionContext,
        }, scratch);

        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.schemaDrift");
        assert.deepEqual(scratch.destroyed.sort(), scratch.created.map(one => one.id).sort());
    });

    it("compares an older installation against its own confirmed head rather than the catalog tip", () => {
        const catalogTip = projectedB();
        void catalogTip;

        const atOwnHead = checkHistoryHeadDrift(projectedA(), projectedA());
        assert.equal(atOwnHead.ok, true, "an A installation must not be compared to desired/catalog tip B before upgrade");

        const drifted = checkHistoryHeadDrift(projectedA(), projectedB());
        assert.equal(drifted.ok, false);
        assert.equal(firstKey(drifted), "migration.schemaDrift");
    });

    it("refuses to start authoring without an explicit desired SSOT release", () => {
        const missing = requireDesiredRelease(null);
        assert.equal(missing.ok, false);
        assert.equal(firstKey(missing), "migration.invalidReference");

        const desired = releaseInputB();
        const present = requireDesiredRelease(desired);
        assert.equal(present.ok, true);
        if (present.ok) assert.equal(present.value, desired);
    });
});

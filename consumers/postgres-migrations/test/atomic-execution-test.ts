import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {
    MigrationPathInfo,
    PublishedMigrationInfo,
    ReleaseRefInfo,
    ResourceRefInfo,
    ValidationResult,
} from "system-definition";
import type {ManagedDataInfo} from "../src/artifact";
import {
    executeMigration,
    type MigrationExecutionContext,
    type ReleaseExecutionState,
} from "../src/execute-migration";
import type {InstallationScope, JournalConfig} from "../src/journal";
import type {InspectionScope} from "../src/inspect-schema";
import type {PgObjectInfo, PgSchemaInfo, PgSession, ResolvedSqlResource, SqlParameter} from "../src/pg-schema";
import {executeMigrationPath} from "../src/runner";
import {
    executePreparedSqlResource,
    prepareSqlResource,
    runCheckResource,
} from "../src/sql-resource";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_M = "c".repeat(64);
const HASH_BEFORE = "d".repeat(64);
const HASH_DATA = "e".repeat(64);
const HASH_DDL = "f".repeat(64);
const HASH_AFTER = "1".repeat(64);

function release(releaseId: string, releaseHash: string): ReleaseRefInfo {
    return {systemId: "aida", releaseId, releaseHash};
}
const A = release("A", HASH_A);
const B = release("B", HASH_B);

function ref(name: string, kind: ResourceRefInfo["kind"], contentHash: string): ResourceRefInfo {
    return {name, kind, contentHash};
}
const beforeRef = ref("before_ok", "check", HASH_BEFORE);
const dataRef = ref("update_data", "sql", HASH_DATA);
const ddlRef = ref("add_tag", "sql", HASH_DDL);
const afterRef = ref("after_ok", "check", HASH_AFTER);

const published: PublishedMigrationInfo = {
    migration: {
        id: "A-B",
        from: A,
        to: B,
        description: "atomic fixture",
        before: [beforeRef],
        steps: [
            {id: "data", run: dataRef},
            {id: "ddl", run: ddlRef},
        ],
        after: [afterRef],
    },
    migrationHash: HASH_M,
};

const resources: Readonly<Record<string, ResolvedSqlResource>> = {
    before_ok: {ref: beforeRef, text: "SELECT true AS ok /* before */"},
    update_data: {ref: dataRef, text: "UPDATE \"app\".\"items\" SET \"value\" = 'changed' WHERE \"id\" = 1"},
    add_tag: {ref: ddlRef, text: "ALTER TABLE \"app\".\"items\" ADD COLUMN \"tag\" text"},
    after_ok: {ref: afterRef, text: "SELECT true AS ok /* after */"},
};

const table: PgObjectInfo = {
    kind: "table",
    identity: {schema: "app", kind: "table", name: "items", parentName: null, signature: []},
    persistence: "permanent",
    relationKind: "r",
};
const idColumn: PgObjectInfo = {
    kind: "column",
    identity: {schema: "app", kind: "column", name: "id", parentName: "items", signature: []},
    type: {schema: "pg_catalog", name: "int4", modifiers: [], arrayDimensions: 0, collation: null},
    nullable: false,
    defaultExpression: null,
    identityDefinition: null,
    generatedDefinition: null,
};
const valueColumn: PgObjectInfo = {
    kind: "column",
    identity: {schema: "app", kind: "column", name: "value", parentName: "items", signature: []},
    type: {schema: "pg_catalog", name: "text", modifiers: [], arrayDimensions: 0, collation: null},
    nullable: true,
    defaultExpression: null,
    identityDefinition: null,
    generatedDefinition: null,
};
const tagColumn: PgObjectInfo = {
    kind: "column",
    identity: {schema: "app", kind: "column", name: "tag", parentName: "items", signature: []},
    type: {schema: "pg_catalog", name: "text", modifiers: [], arrayDimensions: 0, collation: null},
    nullable: true,
    defaultExpression: null,
    identityDefinition: null,
    generatedDefinition: null,
};

function schema(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects};
}
const sourceSchema = schema([table, idColumn, valueColumn]);
const targetSchema = schema([table, idColumn, valueColumn, tagColumn]);
const inspection: InspectionScope = {schemas: ["app"], excluded: []};
const emptyManaged = [] as readonly ManagedDataInfo[];

function state(expectedSchema: PgSchemaInfo): ReleaseExecutionState {
    return {expectedSchema, inspection, managedData: emptyManaged, invariantChecks: []};
}

const journal: JournalConfig = {schema: "sd_journal"};
const scope: InstallationScope = {systemId: "aida", schemas: ["app"]};

function context(): MigrationExecutionContext {
    return {
        journal,
        scope,
        resources,
        from: state(sourceSchema),
        to: state(targetSchema),
        options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
        now: () => "2026-09-28T12:00:00.000Z",
    };
}

type QueryCall = {text: string; values: readonly SqlParameter[]};
type QueryResult = {rows: readonly Readonly<Record<string, unknown>>[]; rowCount: number | null};

function catalogRows(withTag: boolean, withDrift = false): readonly Readonly<Record<string, unknown>>[] {
    const rows: Readonly<Record<string, unknown>>[] = [
        {
            object_kind: "table", schema_name: "app", object_name: "items", parent_name: null,
            signature: [], persistence: "p", relation_kind: "r", oid: 100,
        },
        {
            object_kind: "column", schema_name: "app", object_name: "id", parent_name: "items", signature: [],
            type_schema: "pg_catalog", type_name: "int4", type_modifiers: [], array_dimensions: 0,
            collation: null, nullable: false, default_expression: null, identity_definition: null,
            generated_definition: null, oid: 101,
        },
        {
            object_kind: "column", schema_name: "app", object_name: "value", parent_name: "items", signature: [],
            type_schema: "pg_catalog", type_name: "text", type_modifiers: [], array_dimensions: 0,
            collation: null, nullable: true, default_expression: null, identity_definition: null,
            generated_definition: null, oid: 102,
        },
    ];
    if (withTag) {
        rows.push({
            object_kind: "column", schema_name: "app", object_name: "tag", parent_name: "items", signature: [],
            type_schema: "pg_catalog", type_name: "text", type_modifiers: [], array_dimensions: 0,
            collation: null, nullable: true, default_expression: null, identity_definition: null,
            generated_definition: null, oid: 103,
        });
    }
    if (withDrift) {
        rows.push({
            object_kind: "table", schema_name: "app", object_name: "manual_extra", parent_name: null,
            signature: [], persistence: "p", relation_kind: "r", oid: 104,
        });
    }
    return rows;
}

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

class AtomicSession implements PgSession {
    readonly calls: QueryCall[] = [];
    closed = false;
    dataChanged = false;
    tagPresent = false;
    journalAdvanced = false;
    private inTransaction = false;
    private beforeData = false;
    private beforeTag = false;
    private beforeJournal = false;

    constructor(
        private readonly afterOk: boolean,
        private readonly driftBefore: boolean = false,
    ) {}

    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        this.calls.push({text, values});
        const normalized = text.trim();
        if (/^BEGIN$/i.test(normalized)) {
            assert.equal(this.inTransaction, false);
            this.inTransaction = true;
            this.beforeData = this.dataChanged;
            this.beforeTag = this.tagPresent;
            this.beforeJournal = this.journalAdvanced;
            return {rows: [], rowCount: null};
        }
        if (/^ROLLBACK$/i.test(normalized)) {
            assert.equal(this.inTransaction, true);
            this.dataChanged = this.beforeData;
            this.tagPresent = this.beforeTag;
            this.journalAdvanced = this.beforeJournal;
            this.inTransaction = false;
            return {rows: [], rowCount: null};
        }
        if (/^COMMIT$/i.test(normalized)) {
            assert.equal(this.inTransaction, true);
            this.inTransaction = false;
            return {rows: [], rowCount: null};
        }
        if (/^SET LOCAL\s+(statement_timeout|lock_timeout)/i.test(normalized)) {
            assert.equal(this.inTransaction, true);
            return {rows: [], rowCount: null};
        }
        if (/\bFROM\s+"?sd_journal"?\.installation\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: [installationRow(A)], rowCount: 1};
        }
        if (/\bFROM\s+"?sd_journal"?\.migration_history\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: [], rowCount: 0};
        }
        if (/pg_catalog/i.test(text)) {
            return {
                rows: catalogRows(this.tagPresent, this.driftBefore && !this.tagPresent),
                rowCount: null,
            };
        }
        if (/\/\* before \*\//i.test(text)) return {rows: [{ok: true}], rowCount: 1};
        if (/\/\* after \*\//i.test(text)) return {rows: [{ok: this.afterOk}], rowCount: 1};
        if (/^UPDATE\s+"app"\."items"/i.test(normalized)) {
            assert.equal(this.inTransaction, true);
            this.dataChanged = true;
            return {rows: [], rowCount: 1};
        }
        if (/^ALTER TABLE\s+"app"\."items"\s+ADD COLUMN/i.test(normalized)) {
            assert.equal(this.inTransaction, true);
            this.tagPresent = true;
            return {rows: [], rowCount: null};
        }
        if (/WITH\s+current_installation/i.test(text) && /inserted_history/i.test(text) && /updated_installation/i.test(text)) {
            assert.equal(this.inTransaction, true);
            this.journalAdvanced = true;
            return {rows: [installationRow(B)], rowCount: 1};
        }
        throw new Error("unexpected SQL in T11 fixture: " + normalized.slice(0, 120));
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

function success<T>(value: T): ValidationResult<T> {
    return {ok: true, value};
}

function callIndex(session: AtomicSession, pattern: RegExp): number {
    return session.calls.findIndex(one => pattern.test(one.text));
}

function countCalls(session: AtomicSession, pattern: RegExp): number {
    return session.calls.filter(one => pattern.test(one.text)).length;
}

describe("atomic migration execution", () => {
    it("parses multiple statements without splitting quoted semicolons and rejects transaction/non-atomic effects", async () => {
        const allowed: ResolvedSqlResource = {
            ref: dataRef,
            text: "UPDATE app.items SET value = 'a;b' WHERE id = 1;\nALTER TABLE app.items ADD COLUMN note text;",
        };
        const prepared = prepareSqlResource(allowed);
        assert.equal(prepared.ok, true);
        if (!prepared.ok) return;
        assert.equal(prepared.value.statements.length, 2);
        assert.match(prepared.value.statements[0].text, /'a;b'/);

        for (const text of [
            "BEGIN; UPDATE app.items SET value='x'; COMMIT;",
            "CREATE INDEX CONCURRENTLY items_value_idx ON app.items(value);",
            "SELECT nextval('app.seq');",
            "SELECT setval('app.seq', 42);",
        ]) {
            const result = prepareSqlResource({ref: dataRef, text});
            assert.equal(result.ok, false, text);
        }

        const statements: string[] = [];
        const session: PgSession = {
            async query(text, _values) { statements.push(text); return {rows: [], rowCount: null}; },
            async close() {},
        };
        const executed = await executePreparedSqlResource(session, prepared.value);
        assert.equal(executed.ok, true);
        assert.equal(statements.length, 2);
        assert.equal(statements.some(one => /\b(COMMIT|ROLLBACK|BEGIN)\b/i.test(one)), false);
    });

    it("requires a check to return exactly one row shaped only as {ok:boolean}", async () => {
        async function run(rows: readonly Readonly<Record<string, unknown>>[]): Promise<boolean> {
            const session: PgSession = {
                async query() { return {rows, rowCount: rows.length}; },
                async close() {},
            };
            const result = await runCheckResource(session, resources.after_ok);
            return result.ok;
        }
        assert.equal(await run([{ok: true}]), true);
        assert.equal(await run([{ok: false}]), false);
        assert.equal(await run([]), false);
        assert.equal(await run([{ok: true}, {ok: true}]), false);
        assert.equal(await run([{ok: "true"}]), false);
        assert.equal(await run([{ok: true, extra: 1}]), false);
    });

    it("rolls back data and DDL when a late check fails, with no history/head confirmation and no partial step commit", async () => {
        const session = new AtomicSession(false);
        const result = await executeMigration(session, published, context());
        assert.equal(result.ok, false);
        assert.equal(session.dataChanged, false, "UPDATE must be rolled back");
        assert.equal(session.tagPresent, false, "DDL must be rolled back");
        assert.equal(session.journalAdvanced, false, "history/head must not advance");
        assert.equal(countCalls(session, /^BEGIN$/i), 1);
        assert.equal(countCalls(session, /^ROLLBACK$/i), 1);
        assert.equal(countCalls(session, /^COMMIT$/i), 0);
        assert.ok(callIndex(session, /^UPDATE /i) > callIndex(session, /\/\* before \*\//i));
        assert.ok(callIndex(session, /^ALTER TABLE /i) > callIndex(session, /^UPDATE /i));
        assert.ok(callIndex(session, /\/\* after \*\//i) > callIndex(session, /^ALTER TABLE /i));
        assert.equal(session.calls.some(one => /WITH\s+current_installation/i.test(one.text)), false);
    });

    it("blocks source drift before migration resources and confirms history/head before the single commit on success", async () => {
        const drifted = new AtomicSession(true, true);
        const blocked = await executeMigration(drifted, published, context());
        assert.equal(blocked.ok, false);
        assert.equal(drifted.calls.some(one => /\/\* before \*\//i.test(one.text)), false);
        assert.equal(drifted.calls.some(one => /^UPDATE /i.test(one.text.trim())), false);
        assert.equal(drifted.calls.some(one => /^ALTER TABLE /i.test(one.text.trim())), false);
        assert.equal(countCalls(drifted, /^ROLLBACK$/i), 1);

        const session = new AtomicSession(true);
        const applied = await executeMigration(session, published, context());
        assert.equal(applied.ok, true);
        if (!applied.ok) return;
        assert.deepEqual(applied.value.history.from, A);
        assert.deepEqual(applied.value.history.to, B);
        assert.equal(applied.value.history.ordinal, 1);
        assert.equal(session.dataChanged, true);
        assert.equal(session.tagPresent, true);
        assert.equal(session.journalAdvanced, true);
        assert.equal(countCalls(session, /^BEGIN$/i), 1);
        assert.equal(countCalls(session, /^COMMIT$/i), 1);
        assert.equal(countCalls(session, /^ROLLBACK$/i), 0);
        const append = callIndex(session, /WITH\s+current_installation/i);
        const commit = callIndex(session, /^COMMIT$/i);
        assert.ok(append >= 0 && append < commit, "history/head must be durable in the same transaction before COMMIT");
        assert.equal(session.calls.slice(0, commit).filter(one => /^COMMIT$/i.test(one.text.trim())).length, 0);
    });

    it("runs a migration path through the same transactional engine and same PgSession", async () => {
        const session = new AtomicSession(true);
        const path: MigrationPathInfo = {from: A, to: B, migrations: [published]};
        const result = await executeMigrationPath(session, path, () => success(context()));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.from, A);
        assert.deepEqual(result.value.to, B);
        assert.equal(result.value.committed.length, 1);
        assert.equal(result.value.committed[0].migrationId, "A-B");
        assert.equal(countCalls(session, /^BEGIN$/i), 1);
        assert.equal(countCalls(session, /^COMMIT$/i), 1);
    });
});

import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    problem,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
} from "system-definition";
import {
    executeMigration,
    type AuthoringCheckpointExecution,
    type MigrationExecutionContext,
    type ReleaseExecutionState,
} from "../src/execute-migration";
import type {ManagedDataInfo} from "../src/artifact";
import type {InstallationScope, JournalConfig} from "../src/journal";
import type {InspectionScope} from "../src/inspect-schema";
import type {QueryRefInfo} from "../src/migration-authoring";
import type {PgObjectInfo, PgSchemaInfo, PgSession, ResolvedSqlResource, SqlParameter} from "../src/pg-schema";
import {
    validationArtifactEvidenceHash,
    type ValidationArtifactHost,
    type ValidationArtifactInfo,
} from "../src/validation-artifact";

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const fixedHash = (digit: string): string => digit.repeat(64);

const A: ReleaseRefInfo = {systemId: "demo", releaseId: "A", releaseHash: fixedHash("a")};
const B: ReleaseRefInfo = {systemId: "demo", releaseId: "B", releaseHash: fixedHash("b")};
const migrationHash = fixedHash("c");

function resource(name: string, kind: ResourceRefInfo["kind"], digit: string): ResourceRefInfo {
    return {name, kind, contentHash: fixedHash(digit)};
}

const stepOne = resource("step-one", "sql", "1");
const stepTwo = resource("step-two", "sql", "2");
const checkpointCheck = resource("checkpoint-ok", "check", "3");
const checkpointFalse = resource("checkpoint-false", "check", "4");

const published: PublishedMigrationInfo = {
    migration: {
        id: "A-B-checkpoints",
        from: A,
        to: B,
        description: "checkpoint fixture",
        before: [],
        steps: [
            {id: "step-one", run: stepOne},
            {id: "step-two", run: stepTwo},
        ],
        after: [],
    },
    migrationHash,
};

const resources: Readonly<Record<string, ResolvedSqlResource>> = {
    "step-one": {ref: stepOne, text: "SELECT 1 /* step-one */"},
    "step-two": {ref: stepTwo, text: "SELECT 2 /* step-two */"},
    "checkpoint-ok": {ref: checkpointCheck, text: "SELECT true AS ok /* checkpoint-ok */"},
    "checkpoint-false": {ref: checkpointFalse, text: "SELECT false AS ok /* checkpoint-false */"},
};

const table: PgObjectInfo = {
    kind: "table",
    identity: {schema: "app", kind: "table", name: "people", parentName: null, signature: []},
    persistence: "permanent",
    relationKind: "r",
};
const idColumn: PgObjectInfo = {
    kind: "column",
    identity: {schema: "app", kind: "column", name: "id", parentName: "people", signature: []},
    type: {schema: "pg_catalog", name: "int4", modifiers: [], arrayDimensions: 0, collation: null},
    nullable: false,
    defaultExpression: null,
    identityDefinition: null,
    generatedDefinition: null,
};
const emailColumn: PgObjectInfo = {
    kind: "column",
    identity: {schema: "app", kind: "column", name: "email", parentName: "people", signature: []},
    type: {schema: "pg_catalog", name: "text", modifiers: [], arrayDimensions: 0, collation: null},
    nullable: false,
    defaultExpression: null,
    identityDefinition: null,
    generatedDefinition: null,
};
const expectedSchema: PgSchemaInfo = {
    formatVersion: 1,
    engineVersion: "18.6",
    schemas: ["app"],
    objects: [table, idColumn, emailColumn],
};
const snapshot: SystemSnapshotInfo = {
    formatVersion: 1,
    systemId: "demo",
    typeNames: ["integer", "text"],
    entities: {
        people: {
            name: "people",
            record: "people",
            fields: {
                id: {name: "id", type: "integer", nullable: false},
                email: {name: "email", type: "text", nullable: false},
            },
            pk: ["id"],
            uks: {},
            fks: {},
            validators: ["validEmail"],
        },
    },
    records: {},
};
const snapshotHash = fixedHash("5");

const inspection: InspectionScope = {schemas: ["app"], excluded: []};
const emptyManaged = [] as readonly ManagedDataInfo[];
function releaseState(): ReleaseExecutionState {
    return {expectedSchema, inspection, managedData: emptyManaged, invariantChecks: []};
}
const journal: JournalConfig = {schema: "sd_journal"};
const scope: InstallationScope = {systemId: "demo", schemas: ["app"]};

const rowSql = "SELECT '1' AS id, 'ok@example.test' AS email /* checkpoint-row */";
const rowRef: QueryRefInfo = {name: "people-after-step-one.sql", kind: "query", contentHash: hash(rowSql)};
const moduleBytes = new TextEncoder().encode("historical-validator-module-v1");
const artifact: ValidationArtifactInfo = {
    formatVersion: 1,
    side: "to",
    snapshotHash,
    entry: {path: "validation/to.mjs", contentHash: createHash("sha256").update(moduleBytes).digest("hex"), byteLength: moduleBytes.byteLength},
    runtime: {nodeVersion: process.version, abi: "migration-validation-1"},
    domainContractHashes: {integer: fixedHash("6"), text: fixedHash("7")},
    entityValidatorNames: {people: ["validEmail"]},
};
const artifactHash = validationArtifactEvidenceHash(artifact);

function authoringExecution(options: {
    check?: ResourceRefInfo;
    validatorProblem?: boolean;
    queryText?: string;
    afterStep?: string;
    rowAfterStep?: string;
} = {}): {execution: AuthoringCheckpointExecution; validatorCalls: {count: number}} {
    const validatorCalls = {count: 0};
    const host: ValidationArtifactHost = {
        nodeVersion: process.version,
        async readEntry() { return moduleBytes; },
        async importModule() {
            return {
                abi: "migration-validation-1" as const,
                snapshotHash,
                validatePorts: () => [],
                validateEntityRow: () => {
                    validatorCalls.count++;
                    return options.validatorProblem
                        ? [problem(null, "demo.invalidEmail", "regular")]
                        : [];
                },
            };
        },
    };
    return {
        validatorCalls,
        execution: {
            checkpoints: [{
                afterStep: options.afterStep ?? "step-one",
                checks: [options.check ?? checkpointCheck],
                rows: [{
                    id: "people-after-step-one",
                    afterStep: options.rowAfterStep ?? "step-one",
                    side: "to",
                    entity: "people",
                    select: rowRef,
                    validatorArtifactHash: artifactHash,
                }],
            }],
            queryResources: {
                [rowRef.name]: {ref: rowRef, text: options.queryText ?? rowSql},
            },
            validationArtifacts: [artifact],
            validationHost: host,
            snapshots: {
                from: {snapshot, snapshotHash},
                to: {snapshot, snapshotHash},
            },
        },
    };
}

function baseContext(): MigrationExecutionContext {
    return {
        journal,
        scope,
        resources,
        from: releaseState(),
        to: releaseState(),
        options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000},
        now: () => "2026-09-30T18:00:00.000Z",
    };
}

function contextWith(authoring: AuthoringCheckpointExecution): MigrationExecutionContext & {authoring: AuthoringCheckpointExecution} {
    return {...baseContext(), authoring};
}

type QueryCall = {text: string; values: readonly SqlParameter[]};
type QueryResult = {rows: readonly Readonly<Record<string, unknown>>[]; rowCount: number | null};

function catalogRows(): readonly Readonly<Record<string, unknown>>[] {
    return [
        {
            object_kind: "table", schema_name: "app", object_name: "people", parent_name: null,
            signature: [], persistence: "p", relation_kind: "r", oid: 100,
        },
        {
            object_kind: "column", schema_name: "app", object_name: "id", parent_name: "people", signature: [],
            type_schema: "pg_catalog", type_name: "int4", type_modifiers: [], array_dimensions: 0,
            collation: null, nullable: false, default_expression: null, identity_definition: null,
            generated_definition: null, oid: 101,
        },
        {
            object_kind: "column", schema_name: "app", object_name: "email", parent_name: "people", signature: [],
            type_schema: "pg_catalog", type_name: "text", type_modifiers: [], array_dimensions: 0,
            collation: null, nullable: false, default_expression: null, identity_definition: null,
            generated_definition: null, oid: 102,
        },
    ];
}

function installationRow(current: ReleaseRefInfo): Readonly<Record<string, unknown>> {
    return {
        installation_id: "installation-1",
        system_id: "demo",
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

class CheckpointSession implements PgSession {
    readonly calls: QueryCall[] = [];
    journalAdvanced = false;
    private inTransaction = false;

    async query(text: string, values: readonly SqlParameter[]): Promise<QueryResult> {
        this.calls.push({text, values});
        const normalized = text.trim();
        if (/^BEGIN$/i.test(normalized)) {
            this.inTransaction = true;
            return {rows: [], rowCount: null};
        }
        if (/^ROLLBACK$/i.test(normalized)) {
            this.inTransaction = false;
            this.journalAdvanced = false;
            return {rows: [], rowCount: null};
        }
        if (/^COMMIT$/i.test(normalized)) {
            assert.equal(this.inTransaction, true);
            this.inTransaction = false;
            return {rows: [], rowCount: null};
        }
        if (/^SET LOCAL\s+(statement_timeout|lock_timeout)/i.test(normalized)) return {rows: [], rowCount: null};
        if (/\bFROM\s+"?sd_journal"?\.installation\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: [installationRow(A)], rowCount: 1};
        }
        if (/\bFROM\s+"?sd_journal"?\.migration_history\b/i.test(text) && !/WITH\s+current_installation/i.test(text)) {
            return {rows: [], rowCount: 0};
        }
        if (/pg_catalog/i.test(text)) return {rows: catalogRows(), rowCount: null};
        if (/checkpoint-ok/i.test(text)) return {rows: [{ok: true}], rowCount: 1};
        if (/checkpoint-false/i.test(text)) return {rows: [{ok: false}], rowCount: 1};
        if (/checkpoint-row/i.test(text)) return {rows: [{id: "1", email: "ok@example.test"}], rowCount: 1};
        if (/step-one/i.test(text) || /step-two/i.test(text)) return {rows: [], rowCount: 1};
        if (/WITH\s+current_installation/i.test(text) && /inserted_history/i.test(text) && /updated_installation/i.test(text)) {
            this.journalAdvanced = true;
            return {rows: [installationRow(B)], rowCount: 1};
        }
        throw new Error("unexpected SQL in T20 checkpoint fixture: " + normalized.slice(0, 120));
    }

    async close(): Promise<void> {}
}

function callIndex(session: CheckpointSession, pattern: RegExp): number {
    return session.calls.findIndex(call => pattern.test(call.text));
}

function countCalls(session: CheckpointSession, pattern: RegExp): number {
    return session.calls.filter(call => pattern.test(call.text)).length;
}

describe("T20 authoring checkpoints in the transactional runner", () => {
    it("runs checkpoint SQL checks, then row validation, before the next migration step and before commit", async () => {
        const {execution, validatorCalls} = authoringExecution();
        const session = new CheckpointSession();
        const result = await executeMigration(session, published, contextWith(execution));

        assert.equal(result.ok, true);
        assert.equal(validatorCalls.count, 1);
        const firstStep = callIndex(session, /step-one/);
        const sqlCheck = callIndex(session, /checkpoint-ok/);
        const rowCheck = callIndex(session, /checkpoint-row/);
        const secondStep = callIndex(session, /step-two/);
        const commit = callIndex(session, /^COMMIT$/i);
        assert.ok(firstStep >= 0 && firstStep < sqlCheck);
        assert.ok(sqlCheck < rowCheck);
        assert.ok(rowCheck < secondStep);
        assert.ok(secondStep < commit);
    });

    it("rolls back immediately when a checkpoint SQL check fails, without row validation, later steps or history advancement", async () => {
        const {execution, validatorCalls} = authoringExecution({check: checkpointFalse});
        const session = new CheckpointSession();
        const result = await executeMigration(session, published, contextWith(execution));

        assert.equal(result.ok, false);
        assert.equal(validatorCalls.count, 0);
        assert.equal(countCalls(session, /checkpoint-row/), 0);
        assert.equal(countCalls(session, /step-two/), 0);
        assert.equal(countCalls(session, /^ROLLBACK$/i), 1);
        assert.equal(countCalls(session, /^COMMIT$/i), 0);
        assert.equal(session.journalAdvanced, false);
    });

    it("treats every historical validator Problem as blocking inside the migration transaction", async () => {
        const {execution, validatorCalls} = authoringExecution({validatorProblem: true});
        const session = new CheckpointSession();
        const result = await executeMigration(session, published, contextWith(execution));

        assert.equal(result.ok, false);
        assert.equal(validatorCalls.count, 1);
        assert.equal(result.ok ? "" : result.problems[0]?.messageKey, "demo.invalidEmail");
        assert.equal(countCalls(session, /step-two/), 0);
        assert.equal(countCalls(session, /^ROLLBACK$/i), 1);
        assert.equal(session.journalAdvanced, false);
    });

    it("rejects tampered row-query bytes before executing the query or advancing to the next step", async () => {
        const {execution, validatorCalls} = authoringExecution({queryText: rowSql + " -- tampered"});
        const session = new CheckpointSession();
        const result = await executeMigration(session, published, contextWith(execution));

        assert.equal(result.ok, false);
        assert.equal(validatorCalls.count, 0);
        assert.equal(countCalls(session, /checkpoint-row/), 0);
        assert.equal(countCalls(session, /step-two/), 0);
        assert.equal(countCalls(session, /^ROLLBACK$/i), 1);
    });

    it("rejects duplicate/unknown checkpoint placement and row afterStep mismatches before opening a transaction", async () => {
        const valid = authoringExecution().execution;
        const variants: AuthoringCheckpointExecution[] = [
            {...valid, checkpoints: [...valid.checkpoints, valid.checkpoints[0]!]},
            authoringExecution({afterStep: "missing-step", rowAfterStep: "missing-step"}).execution,
            authoringExecution({rowAfterStep: "step-two"}).execution,
        ];

        for (const execution of variants) {
            const session = new CheckpointSession();
            const result = await executeMigration(session, published, contextWith(execution));
            assert.equal(result.ok, false);
            assert.equal(countCalls(session, /^BEGIN$/i), 0);
        }
    });
});

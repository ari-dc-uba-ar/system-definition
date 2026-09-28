import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
import type {PgObjectInfo, PgSchemaInfo, PgSession, SqlParameter} from "../src/pg-schema";
import {
    verifyRelease,
    verifyUpgrade,
    type ReleaseVerificationInput,
    type ScratchHandle,
    type ScratchProvider,
} from "../src/verify";
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
    expectedRowsAfterUpgrade,
    loadAidaEmailFixture,
    projectedA,
    projectedB,
    verifyAidaEmailFixture,
} from "../fixtures/aida-email";

type QueryResult = {rows: readonly Readonly<Record<string, unknown>>[]; rowCount: number | null};

type StudentRow = {alumno: string; apellido: string; nombres: string; email: string | null};
type ContactRow = {alumno: string; email: string};

function problem(messageKey: string, details: Readonly<Record<string, string>> = {}): Problem {
    return {field: null, messageKey, severity: "blocking", details};
}

function releaseRow(current: ReleaseRefInfo): Readonly<Record<string, unknown>> {
    return {
        installation_id: "scratch-installation",
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
        throw new Error("aida-email fixture only projects table/column/constraint objects");
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

class ScratchSession implements PgSession {
    readonly calls: {text: string; values: readonly SqlParameter[]}[] = [];
    closed = false;
    students: StudentRow[] = [];
    contacts: ContactRow[] = [];
    currentRelease: ReleaseRefInfo | null = null;
    history: Readonly<Record<string, unknown>>[] = [];
    currentSchema: PgSchemaInfo;
    private transactionSnapshot: {students: StudentRow[]; contacts: ContactRow[]; schema: PgSchemaInfo; release: ReleaseRefInfo | null; history: Readonly<Record<string, unknown>>[]} | null = null;

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
                students: this.students.map(one => ({...one})),
                contacts: this.contacts.map(one => ({...one})),
                schema: structuredClone(this.currentSchema),
                release: this.currentRelease === null ? null : {...this.currentRelease},
                history: this.history.map(one => ({...one})),
            };
            return {rows: [], rowCount: null};
        }
        if (/^ROLLBACK$/i.test(sql)) {
            if (this.transactionSnapshot !== null) {
                this.students = this.transactionSnapshot.students;
                this.contacts = this.transactionSnapshot.contacts;
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
        if (/^INSERT INTO app\.alumnos/i.test(sql)) {
            this.students.push({alumno: String(values[0]), apellido: String(values[1]), nombres: String(values[2]), email: values[3] === null ? null : String(values[3])});
            return {rows: [], rowCount: 1};
        }
        if (/^INSERT INTO app\.contactos_alumnos/i.test(sql)) {
            this.contacts.push({alumno: String(values[0]), email: String(values[1])});
            return {rows: [], rowCount: 1};
        }
        if (/^SELECT alumno, apellido, nombres, email FROM app\.alumnos/i.test(sql)) {
            return {rows: this.students.slice().sort((a, b) => a.alumno.localeCompare(b.alumno)), rowCount: this.students.length};
        }
        if (/SELECT NOT EXISTS/i.test(text) && /LEFT JOIN app\.contactos_alumnos/i.test(text)) {
            const ok = this.students.every(student => student.email !== null || this.contacts.some(contact => contact.alumno === student.alumno));
            return {rows: [{ok}], rowCount: 1};
        }
        if (/^UPDATE app\.alumnos AS a SET email = c\.email/i.test(sql)) {
            this.students = this.students.map(student => {
                if (student.email !== null) return student;
                const contact = this.contacts.find(one => one.alumno === student.alumno);
                return contact === undefined ? student : {...student, email: contact.email};
            });
            return {rows: [], rowCount: this.students.length};
        }
        if (/^ALTER TABLE app\.alumnos ALTER COLUMN email SET NOT NULL/i.test(sql)) {
            this.currentSchema = setEmailNullable(this.currentSchema, false);
            return {rows: [], rowCount: null};
        }
        if (/SELECT NOT EXISTS \(SELECT 1 FROM app\.alumnos WHERE email IS NULL\)/i.test(sql)) {
            return {rows: [{ok: this.students.every(one => one.email !== null)}], rowCount: 1};
        }
        if (/WITH\s+current_installation/i.test(text)) {
            this.currentRelease = B;
            const row = {
                installation_id: "scratch-installation",
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
            };
            this.history = [row];
            return {rows: [releaseRow(B)], rowCount: 1};
        }
        if (/pg_catalog/i.test(text)) {
            return {rows: catalogRows(this.currentSchema), rowCount: null};
        }
        throw new Error("unexpected scratch SQL: " + sql.slice(0, 120));
    }

    async close(): Promise<void> { this.closed = true; }
}

class OwnedScratchProvider implements ScratchProvider {
    readonly created: ScratchHandle[] = [];
    readonly destroyed: string[] = [];
    readonly sessions: ScratchSession[] = [];
    readonly owned = new Set<ScratchHandle>();
    constructor(private readonly returnUnowned = false) {}

    async create(purpose: "clean-target" | "upgrade-source"): Promise<ValidationResult<ScratchHandle>> {
        const schema = purpose === "clean-target" ? projectedB() : projectedA();
        const session = new ScratchSession(purpose, schema);
        const handle: ScratchHandle = {id: purpose + "-" + (this.created.length + 1), session};
        this.created.push(handle);
        this.sessions.push(session);
        if (!this.returnUnowned) this.owned.add(handle);
        return {ok: true, value: handle};
    }
    owns(handle: ScratchHandle): boolean { return this.owned.has(handle); }
    async destroy(handle: ScratchHandle): Promise<ValidationResult<true>> {
        assert.equal(this.owned.has(handle), true, "provider must never be asked to destroy an unowned handle");
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

describe("two-route release verification", () => {
    it("verifies clean B from SSOT intent without loading A's user fixture", async () => {
        const provider = new OwnedScratchProvider();
        const result = await verifyRelease(releaseInputB(), provider);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value, projectedB());
        assert.equal(provider.sessions.length, 1);
        assert.equal(provider.sessions[0]?.purpose, "clean-target");
        assert.ok(provider.sessions[0]?.calls.some(one => /^CREATE TABLE/i.test(one.text.trim())));
        assert.equal(provider.sessions[0]?.calls.some(one => /^INSERT INTO app\.alumnos/i.test(one.text.trim())), false);
        assert.deepEqual(provider.destroyed, [provider.created[0]?.id]);
    });

    it("verifies A→B against clean B and preserves exact keys and values", async () => {
        const provider = new OwnedScratchProvider();
        const result = await verifyUpgrade({
            source: releaseInputA(), target: releaseInputB(), path: aidaEmailPath,
            journal: aidaEmailJournal, scope: aidaEmailScope,
            fixture: {id: "aida-email", load: loadAidaEmailFixture, verify: verifyAidaEmailFixture},
            resolveContext: executionContext,
        }, provider);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.cleanTarget, projectedB());
        assert.deepEqual(result.value.upgradedTarget, projectedB());
        assert.equal(result.value.fixtureId, "aida-email");
        const upgraded = provider.sessions.find(one => one.purpose === "upgrade-source");
        assert.ok(upgraded);
        assert.deepEqual(upgraded.students, expectedRowsAfterUpgrade);
        assert.deepEqual(provider.destroyed.sort(), provider.created.map(one => one.id).sort());
    });

    it("fails structural verification when SET NOT NULL is omitted even though every data check passes", async () => {
        const provider = new OwnedScratchProvider();
        const result = await verifyUpgrade({
            source: releaseInputA(), target: releaseInputB(), path: aidaEmailPathWithoutAlter,
            journal: aidaEmailJournal, scope: aidaEmailScope,
            fixture: {id: "aida-email", load: loadAidaEmailFixture, verify: verifyAidaEmailFixture},
            resolveContext: executionContext,
        }, provider);
        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.schemaDrift");
        const upgraded = provider.sessions.find(one => one.purpose === "upgrade-source");
        assert.ok(upgraded);
        assert.equal(upgraded.students.every(one => one.email !== null), true, "data check must have passed before structure catches the omission");
        assert.deepEqual(provider.destroyed.sort(), provider.created.map(one => one.id).sort());
    });

    it("uses provider ownership rather than a forgeable scratch flag and never cleans an unowned target", async () => {
        const provider = new OwnedScratchProvider(true);
        const result = await verifyRelease(releaseInputB(), provider);
        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.invalidReference");
        assert.deepEqual(provider.destroyed, []);
        assert.equal(provider.sessions[0]?.calls.length, 0, "an unowned handle must not execute create/inspection SQL");
    });
});

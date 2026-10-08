import {AuthoringFiles} from "../src/authoring-files";
import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ReleaseRefInfo, ResourceRefInfo, ValidationResult} from "system-definition";
import {
    compileDraft,
    type AuthoringRuntime,
    type ManualStepInfo,
    type MigrationDraftInfo,
    type StructureChangeInfo,
} from "../src/authoring";
import {inferStructureChanges} from "../src/infer";
import * as authoringCli from "../src/authoring-cli";
import {
    computeDraftRevisionHash,
    type AuthoringDraftStore,
} from "../src/authoring-cli";
import type {PgObjectIdentity, PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

const fixedHash = (digit: string): string => digit.repeat(64);
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const base = {
    from: {systemId: "demo", releaseId: "A", releaseHash: fixedHash("1")},
    to: {systemId: "demo", releaseId: "B", releaseHash: fixedHash("2")},
    fromSnapshotHash: fixedHash("3"),
    toSnapshotHash: fixedHash("4"),
    fromPersistenceHash: fixedHash("5"),
    toPersistenceHash: fixedHash("6"),
} as const;

function table(name: string): PgObjectInfo {
    return {
        kind: "table",
        identity: {schema: "app", kind: "table", name, parentName: null, signature: []},
        persistence: "permanent",
        relationKind: "r",
    };
}

function column(tableName: string, name: string, nullable = true): PgObjectInfo {
    return {
        kind: "column",
        identity: {schema: "app", kind: "column", name, parentName: tableName, signature: []},
        type: {
            schema: "pg_catalog",
            name: "text",
            modifiers: [],
            arrayDimensions: 0,
            collation: null,
        },
        nullable,
        defaultExpression: null,
        identityDefinition: null,
        generatedDefinition: null,
    };
}

function schema(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects};
}

function identity(tableName: string, name: string): PgObjectIdentity {
    return {schema: "app", kind: "column", name, parentName: tableName, signature: []};
}

function sql(name: string, digit: string): ResourceRefInfo {
    return {name, kind: "sql", contentHash: fixedHash(digit)};
}

function check(name: string, digit: string): ResourceRefInfo {
    return {name, kind: "check", contentHash: fixedHash(digit)};
}

function infer(from: PgSchemaInfo, to: PgSchemaInfo): readonly StructureChangeInfo[] {
    const result = inferStructureChanges(base, from, to, []);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("inference fixture must succeed");
    return result.value;
}

function addedColumn(changes: readonly StructureChangeInfo[], name: string): StructureChangeInfo {
    const found = changes.find(change => change.action === "add"
        && change.after?.kind === "column"
        && change.after.name === name);
    if (found === undefined) throw new Error(`expected added column ${name}`);
    return found;
}

function step(
    id: string,
    overrides: Partial<ManualStepInfo> = {},
): ManualStepInfo {
    return {
        id,
        run: sql(id + ".sql", id === "alpha" ? "a" : id === "beta" ? "b" : "7"),
        dependsOn: [],
        implementsChanges: [],
        reads: [],
        writes: [],
        destroys: [],
        before: [],
        after: [],
        rowChecks: [],
        ...overrides,
    };
}

function draft(
    from: PgSchemaInfo,
    to: PgSchemaInfo,
    manual: readonly ManualStepInfo[],
): MigrationDraftInfo {
    return {
        formatVersion: 1,
        id: "A-B",
        base,
        revisionHash: fixedHash("9"),
        renames: [],
        changes: infer(from, to),
        data: [],
        decisions: [],
        manual,
        pending: [],
    };
}

type LoadedDesired = {ref: ReleaseRefInfo; expectedSchema: PgSchemaInfo};

class Runtime extends AuthoringFiles implements AuthoringRuntime {
    constructor(
        readonly from: PgSchemaInfo,
        readonly to: PgSchemaInfo,
        readonly inspected: PgSchemaInfo,
    ) { super(); }

    async loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<LoadedDesired>> {
        return {ok: true, value: {ref, expectedSchema: this.to}};
    }

    async reconstructHistory(): Promise<ValidationResult<PgSchemaInfo>> {
        return {ok: true, value: this.from};
    }

    async readQuery(): Promise<ValidationResult<string>> {
        return {ok: true, value: "SELECT 1"};
    }

    async readSql(ref: ResourceRefInfo): Promise<ValidationResult<string>> {
        return {ok: true, value: `SELECT 1 /* ${ref.name} */;`};
    }

    async inspectCompiled(): Promise<ValidationResult<PgSchemaInfo>> {
        return {ok: true, value: this.to};
    }

    async inspectDraft(): Promise<ValidationResult<PgSchemaInfo>> {
        return {ok: true, value: this.inspected};
    }
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

type CompiledCheckpoint = {
    afterStep: string;
    checks: readonly ResourceRefInfo[];
    rows: readonly unknown[];
};

function checkpointsOf(value: {checkpoints: readonly unknown[]}): readonly CompiledCheckpoint[] {
    return value.checkpoints as readonly CompiledCheckpoint[];
}

type AddSqlContract = Omit<ManualStepInfo, "run"> & {resourceName: string};
type AddSqlSessionOptions = {
    draftPath: string;
    store: AuthoringDraftStore;
    file: {path: string; text: string};
    contract: AddSqlContract;
};
type AddSqlSessionReport = {
    ok: boolean;
    revisionHash: string;
    problems: readonly {messageKey: string}[];
    files: readonly {path: string; contentHash: string}[];
};
type RunAddSqlSession = (options: AddSqlSessionOptions) => Promise<AddSqlSessionReport>;

function addSqlSession(): RunAddSqlSession | undefined {
    return (authoringCli as unknown as {runAddSqlSession?: RunAddSqlSession}).runAddSqlSession;
}

class MemoryStore implements AuthoringDraftStore {
    writes = 0;
    constructor(public value: MigrationDraftInfo) {}

    async readDraft(): Promise<ValidationResult<MigrationDraftInfo>> {
        return {ok: true, value: this.value};
    }

    async replaceDraftAtomic(_path: string, next: MigrationDraftInfo): Promise<ValidationResult<true>> {
        this.writes++;
        this.value = next;
        return {ok: true, value: true};
    }
}

describe("T21 final authoring manifest, graph and add-sql integration", () => {
    it("places manual before/after checks in the compiled manifest without losing the step contract", async () => {
        const from = schema([table("people"), column("people", "id", false)]);
        const to = schema([table("people"), column("people", "id", false), column("people", "note")]);
        const change = addedColumn(infer(from, to), "note");
        const pre = check("pre-note", "c");
        const post = check("post-note", "d");
        const manual = step("manual-note", {
            implementsChanges: [change.id],
            writes: [identity("people", "note")],
            before: [pre],
            after: [post],
        });

        const result = await compileDraft(draft(from, to, [manual]), new Runtime(from, to, to));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.migration.before, [pre]);
        assert.deepEqual(result.value.migration.steps, [{id: "manual-note", run: manual.run}]);
        assert.deepEqual(checkpointsOf(result.value), [{afterStep: "manual-note", checks: [post], rows: []}]);
    });

    it("topologically orders manual dependencies even when the draft declares them in reverse", async () => {
        const state = schema([
            table("people"),
            column("people", "id", false),
            column("people", "note"),
            column("people", "tag"),
        ]);
        const alpha = step("alpha", {writes: [identity("people", "note")]});
        const beta = step("beta", {dependsOn: ["alpha"], writes: [identity("people", "tag")]});

        const result = await compileDraft(draft(state, state, [beta, alpha]), new Runtime(state, state, state));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.migration.steps.map(one => one.id), ["alpha", "beta"]);
        assert.deepEqual(
            result.value.operations.filter(one => one.stepIds.length > 0).map(one => one.stepIds[0]),
            ["alpha", "beta"],
        );
    });

    it("rejects unknown and cyclic manual dependencies before producing a publishable manifest", async () => {
        const state = schema([table("people"), column("people", "id", false)]);
        const unknown = step("one", {dependsOn: ["missing"]});
        assert.equal(
            firstKey(await compileDraft(draft(state, state, [unknown]), new Runtime(state, state, state))),
            "migration.invalidReference",
        );

        const cyclic = [
            step("one", {dependsOn: ["two"]}),
            step("two", {dependsOn: ["one"]}),
        ];
        assert.equal(
            firstKey(await compileDraft(draft(state, state, cyclic), new Runtime(state, state, state))),
            "migration.authoringInvalid",
        );
    });

    it("rejects overlapping manual writers unless an explicit dependency orders them", async () => {
        const state = schema([table("people"), column("people", "id", false), column("people", "note")]);
        const first = step("first", {writes: [identity("people", "note")]});
        const second = step("second", {writes: [identity("people", "note")]});

        assert.equal(
            firstKey(await compileDraft(draft(state, state, [first, second]), new Runtime(state, state, state))),
            "migration.authoringInvalid",
        );

        const ordered = step("second", {
            dependsOn: ["first"],
            writes: [identity("people", "note")],
        });
        const result = await compileDraft(draft(state, state, [ordered, first]), new Runtime(state, state, state));
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.migration.steps.map(one => one.id), ["first", "second"]);
    });

    it("uses a lexical tie-break so independent manual declarations compile deterministically", async () => {
        const state = schema([
            table("people"),
            column("people", "id", false),
            column("people", "note"),
            column("people", "tag"),
        ]);
        const alpha = step("alpha", {writes: [identity("people", "note")]});
        const zeta = step("zeta", {writes: [identity("people", "tag")]});

        const reverse = await compileDraft(draft(state, state, [zeta, alpha]), new Runtime(state, state, state));
        const forward = await compileDraft(draft(state, state, [alpha, zeta]), new Runtime(state, state, state));
        assert.equal(reverse.ok, true);
        assert.equal(forward.ok, true);
        if (!reverse.ok || !forward.ok) return;
        assert.deepEqual(reverse.value.migration.steps.map(one => one.id), ["alpha", "zeta"]);
        assert.deepEqual(reverse.value.migration.steps, forward.value.migration.steps);
        assert.deepEqual(reverse.value.operations, forward.value.operations);
    });

    it("adds handwritten SQL through one atomic library session with exact-byte hashing and draft revision update", async () => {
        const run = addSqlSession();
        assert.equal(typeof run, "function", "authoring CLI must expose runAddSqlSession");
        if (run === undefined) return;

        const state = schema([table("people"), column("people", "id", false), column("people", "note")]);
        const initial = draft(state, state, []);
        const initialRevision = computeDraftRevisionHash(initial);
        assert.equal(initialRevision.ok, true);
        if (!initialRevision.ok) return;
        const store = new MemoryStore({...initial, revisionHash: initialRevision.value});
        const text = "UPDATE app.people SET note = note;\n";
        const contract: AddSqlContract = {
            id: "normalize-note",
            resourceName: "normalize-note.sql",
            dependsOn: [],
            implementsChanges: [],
            reads: [identity("people", "note")],
            writes: [identity("people", "note")],
            destroys: [],
            before: [],
            after: [],
            rowChecks: [],
        };

        const first = await run({
            draftPath: "drafts/A-B.json",
            store,
            file: {path: "sql/normalize-note.sql", text},
            contract,
        });
        assert.equal(first.ok, true);
        assert.equal(store.writes, 1);
        assert.equal(store.value.manual.length, 1);
        assert.deepEqual(store.value.manual[0]?.run, {
            name: "normalize-note.sql",
            kind: "sql",
            contentHash: sha256(text),
        });
        assert.deepEqual(first.files, [{path: "sql/normalize-note.sql", contentHash: sha256(text)}]);
        const expectedRevision = computeDraftRevisionHash(store.value);
        assert.equal(expectedRevision.ok, true);
        if (!expectedRevision.ok) return;
        assert.equal(first.revisionHash, expectedRevision.value);

        const second = await run({
            draftPath: "drafts/A-B.json",
            store,
            file: {path: "sql/normalize-note.sql", text},
            contract,
        });
        assert.equal(second.ok, false);
        assert.equal(second.problems[0]?.messageKey, "migration.authoringInvalid");
        assert.equal(store.writes, 1, "duplicate add-sql must not partially rewrite the draft");
    });
});

import {AuthoringFiles} from "../src/authoring-files";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ReleaseRefInfo, ValidationResult} from "system-definition";
import type {AuthoringBaseInfo, StructureChangeInfo} from "../src/authoring-contract";
import {
    compileDraft,
    type AuthoringRuntime,
    type CompiledAuthoringInfo,
    type MigrationDraftInfo,
} from "../src/authoring";
import {inferStructureChanges} from "../src/infer";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

const base: AuthoringBaseInfo = {
    from: {systemId: "demo", releaseId: "A", releaseHash: "1".repeat(64)},
    to: {systemId: "demo", releaseId: "B", releaseHash: "2".repeat(64)},
    fromSnapshotHash: "3".repeat(64),
    toSnapshotHash: "4".repeat(64),
    fromPersistenceHash: "5".repeat(64),
    toPersistenceHash: "6".repeat(64),
};

type ExpectedCompileDraft = (
    draft: MigrationDraftInfo,
    runtime: AuthoringRuntime,
) => Promise<ValidationResult<CompiledAuthoringInfo>>;
const compileDraftContract: ExpectedCompileDraft = compileDraft;
void compileDraftContract;

function table(name: string, persistence = "permanent"): PgObjectInfo {
    return {
        kind: "table",
        identity: {schema: "app", kind: "table", name, parentName: null, signature: []},
        persistence,
        relationKind: "r",
    };
}

function column(tableName: string, name: string, nullable: boolean): PgObjectInfo {
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

function draft(changes: readonly StructureChangeInfo[] = [], pending: readonly unknown[] = []): MigrationDraftInfo {
    return {
        formatVersion: 1,
        id: "A-B",
        base,
        revisionHash: "9".repeat(64),
        renames: [],
        changes,
        data: [],
        decisions: [],
        manual: [],
        pending,
    } as unknown as MigrationDraftInfo;
}

type LoadedDesired = {ref: ReleaseRefInfo; expectedSchema: PgSchemaInfo};

class CompileRuntime extends AuthoringFiles {
    readonly calls: string[] = [];

    constructor(
        readonly history: PgSchemaInfo,
        readonly desired: PgSchemaInfo,
        readonly inspected: PgSchemaInfo,
    ) { super(); }

    async loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<LoadedDesired>> {
        this.calls.push("load:" + ref.releaseId);
        return {ok: true, value: {ref, expectedSchema: this.desired}};
    }

    async reconstructHistory(head: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("history:" + head.releaseId);
        return {ok: true, value: this.history};
    }

    async readQuery(): Promise<ValidationResult<string>> {
        throw new Error("T18 structure-only compilation must not load data queries");
    }

    async inspectCompiled(): Promise<ValidationResult<PgSchemaInfo>> {
        return {ok: true, value: this.desired};
    }

    async inspectDraft(): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("inspect");
        return {ok: true, value: this.inspected};
    }
}

function infer(from: PgSchemaInfo, to: PgSchemaInfo): readonly StructureChangeInfo[] {
    const result = inferStructureChanges(base, from, to, []);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("inference fixture must succeed");
    return result.value;
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

describe("T18 residual structure planning and compileDraft boundary", () => {
    it("emits executable SQL steps for an inferred nullable column addition", async () => {
        const history = schema([table("people"), column("people", "id", false)]);
        const desired = schema([...history.objects, column("people", "nickname", true)]);
        const result = await compileDraft(draft(), new CompileRuntime(history, desired, history));

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.ok(result.value.migration.steps.length > 0,
            "a successful structural compilation must contain executable SQL, not only logical operations");
        const stepIds = new Set(result.value.migration.steps.map(step => step.id));
        for (const operation of result.value.operations) {
            assert.ok(operation.stepIds.length > 0, "every emitted operation must reference executable steps");
            assert.ok(operation.stepIds.every(id => stepIds.has(id)));
        }
        assert.ok(result.value.migration.steps.every(step => step.run.kind === "sql"));
    });

    it("compiles a column removal after its historical source has an explicit discard decision", async () => {
        const desired = schema([table("people"), column("people", "id", false)]);
        const history = schema([...desired.objects, column("people", "legacy", true)]);
        const changes = infer(history, desired);
        const removal = changes.find(change => change.action === "remove" && change.before?.name === "legacy");
        assert.ok(removal);
        const approved: MigrationDraftInfo = {
            ...draft(changes),
            decisions: [{
                changeId: removal.id,
                source: {side: "from", entity: "people", field: "legacy"},
                partitionCheck: null,
                resolution: {kind: "discard", reason: "The owner explicitly retired this field."},
            }],
        };

        const result = await compileDraft(approved, new CompileRuntime(history, desired, history));

        if (!result.ok) assert.fail(JSON.stringify(result.problems));
        assert.ok(result.value.migration.steps.length > 0);
        assert.ok(result.value.operations.some(operation => operation.changeIds.includes(removal.id)
            && operation.stepIds.length > 0));
    });

    it("recomputes the residual against desired and emits only preserving changes still missing after authored effects", async () => {
        const history = schema([table("people"), column("people", "id", false)]);
        const desired = schema([
            table("people"),
            column("people", "id", false),
            column("people", "nickname", true),
            column("people", "bio", true),
        ]);
        const inspectedAfterAuthoredEffects = schema([
            table("people"),
            column("people", "id", false),
            column("people", "nickname", true),
        ]);
        const staleFullDiff = infer(history, desired);
        const residual = infer(inspectedAfterAuthoredEffects, desired);
        assert.equal(residual.length, 1);
        assert.equal(residual[0]?.after?.name, "bio");

        const runtime = new CompileRuntime(history, desired, inspectedAfterAuthoredEffects);
        const result = await compileDraft(
            draft(staleFullDiff),
            runtime as unknown as AuthoringRuntime,
        );

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.operations.map((operation: {changeIds: readonly string[]}) => [...operation.changeIds]), [[residual[0]?.id]]);
        assert.deepEqual(runtime.calls, ["history:A", "load:B", "inspect"]);
        assert.equal(
            result.value.operations.flatMap((operation: {changeIds: readonly string[]}) => operation.changeIds)
                .includes(staleFullDiff.find((change: StructureChangeInfo) => change.after?.name === "nickname")?.id ?? ""),
            false,
            "a change already present after authored effects must not be generated again",
        );
    });

    it("returns pending instead of inventing data when the residual requires a data check", async () => {
        const history = schema([table("people"), column("people", "id", false)]);
        const desired = schema([
            table("people"),
            column("people", "id", false),
            column("people", "code", false),
        ]);
        const runtime = new CompileRuntime(history, desired, history);

        const result = await compileDraft(draft(), runtime as unknown as AuthoringRuntime);

        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.authoringPending");
        assert.deepEqual(runtime.calls, ["history:A", "load:B", "inspect"]);
    });

    it("blocks unsupported residual structure instead of omitting it", async () => {
        const history = schema([table("people", "permanent"), column("people", "id", false)]);
        const desired = schema([table("people", "unlogged"), column("people", "id", false)]);
        const runtime = new CompileRuntime(history, desired, history);

        const result = await compileDraft(draft(), runtime as unknown as AuthoringRuntime);

        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.unsupportedSchemaFeature");
    });

    it("is deterministic and emits no residual operations when inspected draft already equals desired", async () => {
        const history = schema([table("people"), column("people", "id", false)]);
        const desired = schema([
            table("people"),
            column("people", "id", false),
            column("people", "nickname", true),
        ]);

        const first = await compileDraft(
            draft(),
            new CompileRuntime(history, desired, history) as unknown as AuthoringRuntime,
        );
        const second = await compileDraft(
            draft(),
            new CompileRuntime(history, desired, history) as unknown as AuthoringRuntime,
        );
        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        if (first.ok && second.ok) {
            assert.deepEqual(first.value.operations, second.value.operations);
        }

        const complete = await compileDraft(
            draft(),
            new CompileRuntime(history, desired, desired) as unknown as AuthoringRuntime,
        );
        assert.equal(complete.ok, true);
        if (complete.ok) assert.deepEqual(complete.value.operations, []);
    });
});

import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ReleaseRefInfo, ValidationResult} from "system-definition";
import {
    compileDraft,
    type AuthoringRuntime,
    type DestructiveDecisionInfo,
    type MigrationDraftInfo,
    type StructureChangeInfo,
} from "../src/authoring";
import {inferStructureChanges} from "../src/infer";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

const base = {
    from: {systemId: "demo", releaseId: "A", releaseHash: "1".repeat(64)},
    to: {systemId: "demo", releaseId: "B", releaseHash: "2".repeat(64)},
    fromSnapshotHash: "3".repeat(64),
    toSnapshotHash: "4".repeat(64),
    fromPersistenceHash: "5".repeat(64),
    toPersistenceHash: "6".repeat(64),
} as const;

function table(name: string): PgObjectInfo {
    return {
        kind: "table",
        identity: {schema: "app", kind: "table", name, parentName: null, signature: []},
        persistence: "permanent",
        relationKind: "r",
    };
}

function column(tableName: string, name: string): PgObjectInfo {
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
        nullable: true,
        defaultExpression: null,
        identityDefinition: null,
        generatedDefinition: null,
    };
}

function schema(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects};
}

const from = schema([
    table("people"),
    column("people", "id"),
    column("people", "legacy_note"),
]);
const to = schema([
    table("people"),
    column("people", "id"),
]);

function infer(fromSchema = from, toSchema = to): readonly StructureChangeInfo[] {
    const result = inferStructureChanges(base, fromSchema, toSchema, []);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("inference fixture must succeed");
    return result.value;
}

function legacyDrop(): StructureChangeInfo {
    const change = infer().find(one => one.before?.kind === "column" && one.before.name === "legacy_note");
    if (change === undefined) throw new Error("legacy drop fixture must exist");
    assert.equal(change.impact, "destructive");
    return change;
}

function discard(change: StructureChangeInfo, reason = "legacy field retired"): DestructiveDecisionInfo {
    return {
        changeId: change.id,
        source: {side: "from", entity: "people", field: "legacy_note"},
        partitionCheck: null,
        resolution: {kind: "discard", reason},
    };
}

function draft(decisions: readonly DestructiveDecisionInfo[]): MigrationDraftInfo {
    return {
        formatVersion: 1,
        id: "A-B",
        base,
        revisionHash: "9".repeat(64),
        renames: [],
        changes: infer(),
        data: [],
        decisions,
        manual: [],
        pending: [],
    };
}

type LoadedDesired = {ref: ReleaseRefInfo; expectedSchema: PgSchemaInfo};

class Runtime implements AuthoringRuntime {
    readonly calls: string[] = [];

    async loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<LoadedDesired>> {
        this.calls.push("load:" + ref.releaseId);
        return {ok: true, value: {ref, expectedSchema: to}};
    }

    async reconstructHistory(ref: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("history:" + ref.releaseId);
        return {ok: true, value: from};
    }

    async readQuery(): Promise<ValidationResult<string>> {
        throw new Error("discard-only destructive coverage must not load a query");
    }

    async inspectDraft(): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("inspect");
        return {ok: true, value: to};
    }
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

describe("T21 destructive decision coverage", () => {
    it("enumerates every persisted source column when a table is removed", () => {
        const tableDrop = infer(
            schema([table("legacy"), column("legacy", "alpha"), column("legacy", "beta")]),
            schema([]),
        ).find(change => change.before?.kind === "table" && change.before.name === "legacy");

        if (tableDrop === undefined) throw new Error("table drop fixture must exist");
        assert.equal(tableDrop.impact, "destructive");
        assert.deepEqual(tableDrop.affectedFields, [
            {side: "from", entity: "legacy", field: "alpha"},
            {side: "from", entity: "legacy", field: "beta"},
        ]);
    });

    it("does not let an inspected DROP become publishable when its destructive decision is missing", async () => {
        const runtime = new Runtime();
        const result = await compileDraft(draft([]), runtime);

        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.authoringPending");
        assert.deepEqual(runtime.calls, ["history:A", "load:B"]);
    });

    it("accepts one explicit full-field discard and carries the exact decision into the compiled authoring info", async () => {
        const decision = discard(legacyDrop());
        const runtime = new Runtime();
        const result = await compileDraft(draft([decision]), runtime);

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.decisions, [decision]);
        assert.deepEqual(result.value.operations, []);
        assert.deepEqual(runtime.calls, ["history:A", "load:B", "inspect"]);
    });

    it("rejects a stale decision whose change id is not part of the reconstructed destructive diff", async () => {
        const decision = {...discard(legacyDrop()), changeId: "f".repeat(64)};
        const result = await compileDraft(draft([decision]), new Runtime());

        assert.equal(result.ok, false);
        assert.equal(firstKey(result), "migration.invalidReference");
    });

    it("rejects duplicate decisions and an empty discard reason instead of widening either approval", async () => {
        const change = legacyDrop();
        const duplicate = await compileDraft(draft([discard(change), discard(change)]), new Runtime());
        assert.equal(duplicate.ok, false);
        assert.equal(firstKey(duplicate), "migration.authoringInvalid");

        const emptyReason = await compileDraft(draft([discard(change, "")]), new Runtime());
        assert.equal(emptyReason.ok, false);
        assert.equal(firstKey(emptyReason), "migration.authoringInvalid");
    });
});

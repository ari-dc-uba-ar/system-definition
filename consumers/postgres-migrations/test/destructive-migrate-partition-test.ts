import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ReleaseRefInfo, ResourceRefInfo, ValidationResult} from "system-definition";
import {
    compileDraft,
    validateDestructiveDecisions,
    type AuthoringRuntime,
    type DestructiveDecisionInfo,
    type MigrationDraftInfo,
    type StructureChangeInfo,
} from "../src/authoring";
import type {DataMigrationInfo} from "../src/migration-authoring";
import {inferStructureChanges} from "../src/infer";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

const hash = (digit: string): string => digit.repeat(64);

const base = {
    from: {systemId: "demo", releaseId: "A", releaseHash: hash("1")},
    to: {systemId: "demo", releaseId: "B", releaseHash: hash("2")},
    fromSnapshotHash: hash("3"),
    toSnapshotHash: hash("4"),
    fromPersistenceHash: hash("5"),
    toPersistenceHash: hash("6"),
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

const from = schema([
    table("people"),
    column("people", "id", false),
    column("people", "legacy_note"),
]);
const to = schema([
    table("people"),
    column("people", "id", false),
    column("people", "note"),
]);

function infer(): readonly StructureChangeInfo[] {
    const result = inferStructureChanges(base, from, to, []);
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

function check(name: string, digit: string): ResourceRefInfo {
    return {name, kind: "check", contentHash: hash(digit)};
}

function query(name: string, digit: string) {
    return {name, kind: "query" as const, contentHash: hash(digit)};
}

function moveNote(overrides: Partial<DataMigrationInfo> = {}): DataMigrationInfo {
    return {
        id: "move-note",
        description: "preserve legacy note",
        dependsOn: [],
        source: {
            query: query("move-note-source.sql", "7"),
            ports: {
                id: {
                    domain: {side: "from", type: "text", nullable: false},
                    field: {side: "from", entity: "people", field: "id"},
                },
                legacy: {
                    domain: {side: "from", type: "text", nullable: true},
                    field: {side: "from", entity: "people", field: "legacy_note"},
                },
            },
            identity: ["id"],
            coverageChecks: [],
        },
        transformation: "copy-note",
        arguments: {},
        writes: [{
            kind: "update",
            entity: "people",
            values: [{output: "note", target: {side: "to", entity: "people", field: "note"}}],
            match: [{output: "id", targetField: "id"}],
            whenMissing: "error",
        }],
        conservationChecks: [check("note-conserved", "8")],
        ...overrides,
    };
}

function migrate(
    change: StructureChangeInfo,
    overrides: Partial<DestructiveDecisionInfo> = {},
): DestructiveDecisionInfo {
    return {
        changeId: change.id,
        source: {side: "from", entity: "people", field: "legacy_note"},
        partitionCheck: null,
        resolution: {kind: "migrate", dataMigrationId: "move-note", outputs: ["note"]},
        ...overrides,
    };
}

function discardPartition(change: StructureChangeInfo, partitionCheck: ResourceRefInfo): DestructiveDecisionInfo {
    return {
        changeId: change.id,
        source: {side: "from", entity: "people", field: "legacy_note"},
        partitionCheck,
        resolution: {kind: "discard", reason: "this explicit partition is intentionally retired"},
    };
}

function draft(
    data: readonly DataMigrationInfo[],
    decisions: readonly DestructiveDecisionInfo[],
): MigrationDraftInfo {
    return {
        formatVersion: 1,
        id: "A-B",
        base,
        revisionHash: hash("9"),
        renames: [],
        changes: infer(),
        data,
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

    async readQuery(ref: {name: string}): Promise<ValidationResult<string>> {
        this.calls.push("query:" + ref.name);
        return {ok: true, value: "select 1"};
    }

    async inspectDraft(): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("inspect");
        return {ok: true, value: to};
    }
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

describe("T21 migrate decisions, partitions and preservation order", () => {
    it("accepts migrate only when the named data migration consumes the source and writes every named output", async () => {
        const decision = migrate(legacyDrop());
        const result = validateDestructiveDecisions(infer(), [decision], [moveNote()]);

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value, [decision]);
    });

    it("rejects an unknown migration, empty outputs, an unconsumed source and an output not bound by the migration", async () => {
        const change = legacyDrop();

        const unknown = migrate(change, {
            resolution: {kind: "migrate", dataMigrationId: "missing", outputs: ["note"]},
        });
        assert.equal(firstKey(await compileDraft(draft([moveNote()], [unknown]), new Runtime())), "migration.invalidReference");

        const emptyOutputs = migrate(change, {
            resolution: {kind: "migrate", dataMigrationId: "move-note", outputs: []},
        });
        assert.equal(firstKey(await compileDraft(draft([moveNote()], [emptyOutputs]), new Runtime())), "migration.authoringInvalid");

        const noSource = moveNote({
            source: {
                query: query("wrong-source.sql", "a"),
                ports: {
                    id: {
                        domain: {side: "from", type: "text", nullable: false},
                        field: {side: "from", entity: "people", field: "id"},
                    },
                },
                identity: ["id"],
                coverageChecks: [],
            },
        });
        assert.equal(firstKey(await compileDraft(draft([noSource], [migrate(change)]), new Runtime())), "migration.invalidReference");

        const wrongOutput = migrate(change, {
            resolution: {kind: "migrate", dataMigrationId: "move-note", outputs: ["not-written"]},
        });
        assert.equal(firstKey(await compileDraft(draft([moveNote()], [wrongOutput]), new Runtime())), "migration.invalidReference");
    });

    it("treats distinct partition checks as explicit per-partition decisions without widening them to the whole field", async () => {
        const change = legacyDrop();
        const active = check("legacy-active-partition", "b");
        const archived = check("legacy-archived-partition", "c");
        const decisions: readonly DestructiveDecisionInfo[] = [
            migrate(change, {partitionCheck: active}),
            discardPartition(change, archived),
        ];

        const result = validateDestructiveDecisions(infer(), decisions, [moveNote()]);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value, decisions);
    });

    it("rejects duplicate partition coverage, whole-field plus partition widening, and a non-check partition resource", async () => {
        const change = legacyDrop();
        const active = check("legacy-active-partition", "d");

        const duplicate = [
            migrate(change, {partitionCheck: active}),
            discardPartition(change, active),
        ];
        assert.equal(firstKey(await compileDraft(draft([moveNote()], duplicate), new Runtime())), "migration.authoringInvalid");

        const widened = [migrate(change), discardPartition(change, active)];
        assert.equal(firstKey(await compileDraft(draft([moveNote()], widened), new Runtime())), "migration.authoringInvalid");

        const sqlPartition: ResourceRefInfo = {name: "not-a-check.sql", kind: "sql", contentHash: hash("e")};
        assert.equal(
            firstKey(await compileDraft(draft([moveNote()], [migrate(change, {partitionCheck: sqlPartition})]), new Runtime())),
            "migration.authoringInvalid",
        );
    });

    it("refuses to pretend a preserving migration compiled when its runtime has no SQL artifacts or replay", async () => {
        const change = legacyDrop();
        const result = await compileDraft(draft([moveNote()], [migrate(change)]), new Runtime());

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.problems[0]?.messageKey, "migration.authoringInvalid");
    });
});

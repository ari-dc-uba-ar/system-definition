import {AuthoringFiles} from "../src/authoring-files";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ReleaseRefInfo, ResourceRefInfo, ValidationResult} from "system-definition";
import {
    compileDraft,
    type AuthoringRuntime,
    type DestructiveDecisionInfo,
    type MigrationDraftInfo,
    type StructureChangeInfo,
} from "../src/authoring";
import {inferStructureChanges} from "../src/infer";
import type {PgObjectIdentity, PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

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

function identity(tableName: string, name: string): PgObjectIdentity {
    return {schema: "app", kind: "column", name, parentName: tableName, signature: []};
}

function schema(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects};
}

function sql(name: string, digit: string): ResourceRefInfo {
    return {name, kind: "sql", contentHash: hash(digit)};
}

function check(name: string, digit: string): ResourceRefInfo {
    return {name, kind: "check", contentHash: hash(digit)};
}

type ManualStep = {
    id: string;
    run: ResourceRefInfo;
    dependsOn: readonly string[];
    implementsChanges: readonly string[];
    reads: readonly PgObjectIdentity[];
    writes: readonly PgObjectIdentity[];
    destroys: readonly PgObjectIdentity[];
    before: readonly ResourceRefInfo[];
    after: readonly ResourceRefInfo[];
    rowChecks: readonly unknown[];
};

function manualStep(
    id: string,
    implementsChanges: readonly string[],
    overrides: Partial<ManualStep> = {},
): ManualStep {
    return {
        id,
        run: sql(id + ".sql", "7"),
        dependsOn: [],
        implementsChanges,
        reads: [],
        writes: [],
        destroys: [],
        before: [],
        after: [],
        rowChecks: [],
        ...overrides,
    };
}

function infer(from: PgSchemaInfo, to: PgSchemaInfo): readonly StructureChangeInfo[] {
    const result = inferStructureChanges(base, from, to, []);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("inference fixture must succeed");
    return result.value;
}

function columnChange(
    changes: readonly StructureChangeInfo[],
    action: StructureChangeInfo["action"],
    name: string,
): StructureChangeInfo {
    const found = changes.find(change => change.action === action
        && (change.before?.name === name || change.after?.name === name)
        && (change.before?.kind === "column" || change.after?.kind === "column"));
    if (found === undefined) throw new Error(`expected ${action} column change for ${name}`);
    return found;
}

function discard(change: StructureChangeInfo): DestructiveDecisionInfo {
    return {
        changeId: change.id,
        source: {side: "from", entity: "people", field: "legacy_note"},
        partitionCheck: null,
        resolution: {kind: "discard", reason: "legacy value intentionally retired"},
    };
}

function draft(
    from: PgSchemaInfo,
    to: PgSchemaInfo,
    manual: readonly ManualStep[],
    decisions: readonly DestructiveDecisionInfo[] = [],
): MigrationDraftInfo {
    return {
        formatVersion: 1,
        id: "A-B",
        base,
        revisionHash: hash("9"),
        renames: [],
        changes: infer(from, to),
        data: [],
        decisions,
        manual,
        pending: [],
    };
}

type LoadedDesired = {ref: ReleaseRefInfo; expectedSchema: PgSchemaInfo};

class Runtime extends AuthoringFiles implements AuthoringRuntime {
    readonly calls: string[] = [];

    constructor(
        readonly from: PgSchemaInfo,
        readonly to: PgSchemaInfo,
        readonly inspected: PgSchemaInfo,
        readonly sqlText: Readonly<Record<string, string>> = {},
    ) { super(); }

    async loadRelease(ref: ReleaseRefInfo): Promise<ValidationResult<LoadedDesired>> {
        this.calls.push("load:" + ref.releaseId);
        return {ok: true, value: {ref, expectedSchema: this.to}};
    }

    async reconstructHistory(ref: ReleaseRefInfo): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("history:" + ref.releaseId);
        return {ok: true, value: this.from};
    }

    async readQuery(ref: {name: string}): Promise<ValidationResult<string>> {
        this.calls.push("query:" + ref.name);
        return {ok: true, value: "select 1"};
    }

    async readSql(ref: ResourceRefInfo): Promise<ValidationResult<string>> {
        this.calls.push("sql:" + ref.name);
        const value = this.sqlText[ref.name];
        return value === undefined
            ? {ok: false, problems: []}
            : {ok: true, value};
    }

    async inspectCompiled(): Promise<ValidationResult<PgSchemaInfo>> {
        return {ok: true, value: this.to};
    }

    async inspectDraft(): Promise<ValidationResult<PgSchemaInfo>> {
        this.calls.push("inspect");
        return {ok: true, value: this.inspected};
    }
}

function firstKey(result: ValidationResult<unknown>): string | undefined {
    return result.ok ? undefined : result.problems[0]?.messageKey;
}

describe("T21 manual SQL, residual completion and CASCADE boundary", () => {
    it("accepts a declared manual effect and generates only the still-missing preserving residual", async () => {
        const from = schema([table("people"), column("people", "id", false)]);
        const to = schema([
            table("people"),
            column("people", "id", false),
            column("people", "note"),
            column("people", "tag"),
        ]);
        const changes = infer(from, to);
        const note = columnChange(changes, "add", "note");
        const tag = columnChange(changes, "add", "tag");
        const step = manualStep("manual-note", [note.id], {writes: [identity("people", "note")]});
        const inspected = schema([
            table("people"),
            column("people", "id", false),
            column("people", "note"),
        ]);
        const runtime = new Runtime(from, to, inspected, {
            "manual-note.sql": "ALTER TABLE app.people ADD COLUMN note text;",
        });

        const result = await compileDraft(draft(from, to, [step]), runtime);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(result.value.migration.steps[0], {id: "manual-note", run: step.run});
        assert.equal(result.value.migration.steps.length, 2, "the residual must also have an executable SQL step");
        assert.match(runtime.resources.get(result.value.migration.steps[1]!.run.name)!.text, /ADD COLUMN "tag"/);
        const manualOperation = result.value.operations.find(operation => operation.stepIds.includes("manual-note"));
        assert.deepEqual(manualOperation?.changeIds, [note.id]);
        assert.equal(result.value.operations.flatMap(operation => operation.changeIds).filter(id => id === note.id).length, 1);
        assert.equal(result.value.operations.flatMap(operation => operation.changeIds).filter(id => id === tag.id).length, 1);
    });

    it("rejects stale or multiply-claimed changes and a manual run resource that is not SQL", async () => {
        const from = schema([table("people"), column("people", "id", false)]);
        const to = schema([table("people"), column("people", "id", false), column("people", "note")]);
        const change = columnChange(infer(from, to), "add", "note");
        const inspected = to;

        const stale = manualStep("stale", [hash("a")]);
        assert.equal(
            firstKey(await compileDraft(draft(from, to, [stale]), new Runtime(from, to, inspected))),
            "migration.invalidReference",
        );

        const duplicate = [
            manualStep("one", [change.id], {writes: [identity("people", "note")]}),
            manualStep("two", [change.id], {writes: [identity("people", "note")]}),
        ];
        assert.equal(
            firstKey(await compileDraft(draft(from, to, duplicate), new Runtime(from, to, inspected))),
            "migration.authoringInvalid",
        );

        const wrongKind = manualStep("wrong-kind", [change.id], {
            run: check("wrong-kind.check.sql", "b"),
            writes: [identity("people", "note")],
        });
        assert.equal(
            firstKey(await compileDraft(draft(from, to, [wrongKind]), new Runtime(from, to, inspected))),
            "migration.invalidResourceKind",
        );
    });

    it("rejects a claimed effect that reappears after replay or declares an effect contrary to desired SSOT", async () => {
        const from = schema([table("people"), column("people", "id", false)]);
        const to = schema([table("people"), column("people", "id", false), column("people", "note")]);
        const change = columnChange(infer(from, to), "add", "note");
        const step = manualStep("manual-note", [change.id], {writes: [identity("people", "note")]});

        assert.equal(
            firstKey(await compileDraft(draft(from, to, [step]), new Runtime(from, to, from, {
                "manual-note.sql": "ALTER TABLE app.people ADD COLUMN note text;",
            }))),
            "migration.authoringInvalid",
        );

        const contradictory = manualStep("manual-note", [change.id], {
            writes: [identity("people", "note")],
            destroys: [identity("people", "id")],
        });
        assert.equal(
            firstKey(await compileDraft(draft(from, to, [contradictory]), new Runtime(from, to, to, {
                "manual-note.sql": "ALTER TABLE app.people ADD COLUMN note text;",
            }))),
            "migration.authoringInvalid",
        );
    });

    it("requires the same explicit destructive decision for a manual DROP and carries the manual step when authorized", async () => {
        const from = schema([
            table("people"),
            column("people", "id", false),
            column("people", "legacy_note"),
        ]);
        const to = schema([table("people"), column("people", "id", false)]);
        const drop = columnChange(infer(from, to), "remove", "legacy_note");
        const step = manualStep("drop-legacy", [drop.id], {destroys: [identity("people", "legacy_note")]});
        const runtime = () => new Runtime(from, to, to, {
            "drop-legacy.sql": "ALTER TABLE app.people DROP COLUMN legacy_note;",
        });

        assert.equal(firstKey(await compileDraft(draft(from, to, [step]), runtime())), "migration.authoringPending");

        const allowed = await compileDraft(draft(from, to, [step], [discard(drop)]), runtime());
        assert.equal(allowed.ok, true);
        if (!allowed.ok) return;
        assert.deepEqual(allowed.value.migration.steps, [{id: "drop-legacy", run: step.run}]);
        assert.deepEqual(
            allowed.value.operations.find(operation => operation.stepIds.includes("drop-legacy"))?.changeIds,
            [drop.id],
        );
    });

    it("rejects CASCADE in manual destructive SQL instead of using it to hide dependency work", async () => {
        const from = schema([
            table("people"),
            column("people", "id", false),
            column("people", "legacy_note"),
        ]);
        const to = schema([table("people"), column("people", "id", false)]);
        const drop = columnChange(infer(from, to), "remove", "legacy_note");
        const step = manualStep("drop-legacy", [drop.id], {destroys: [identity("people", "legacy_note")]});
        const runtime = new Runtime(from, to, to, {
            "drop-legacy.sql": "ALTER TABLE app.people DROP COLUMN legacy_note CASCADE;",
        });

        assert.equal(
            firstKey(await compileDraft(draft(from, to, [step], [discard(drop)]), runtime)),
            "migration.unsupportedSql",
        );
    });
});

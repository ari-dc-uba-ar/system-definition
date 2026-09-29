import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";
import {
    type AuthoringBaseInfo,
    type RenameInfo,
    type StructureChangeInfo,
} from "../src/authoring-contract";
import {inferStructureChanges} from "../src/infer";

const base: AuthoringBaseInfo = {
    from: {systemId: "demo", releaseId: "A", releaseHash: "1".repeat(64)},
    to: {systemId: "demo", releaseId: "B", releaseHash: "2".repeat(64)},
    fromSnapshotHash: "3".repeat(64),
    toSnapshotHash: "4".repeat(64),
    fromPersistenceHash: "5".repeat(64),
    toPersistenceHash: "6".repeat(64),
};

const _inferSignature: (
    base: AuthoringBaseInfo,
    from: PgSchemaInfo,
    to: PgSchemaInfo,
    renames: readonly RenameInfo[],
) => ValidationResult<readonly StructureChangeInfo[]> = inferStructureChanges;
void _inferSignature;

function table(name: string): PgObjectInfo {
    return {
        kind: "table",
        identity: {schema: "app", kind: "table", name, parentName: null, signature: []},
        persistence: "permanent",
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
    return {
        formatVersion: 1,
        engineVersion: "18.6",
        schemas: ["app"],
        objects,
    };
}

function infer(
    from: PgSchemaInfo,
    to: PgSchemaInfo,
    renames: readonly RenameInfo[] = [],
    authoringBase: AuthoringBaseInfo = base,
): readonly StructureChangeInfo[] {
    const result = inferStructureChanges(authoringBase, from, to, renames);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("inference fixture must succeed");
    return result.value;
}

function byAfterName(changes: readonly StructureChangeInfo[], name: string): StructureChangeInfo | undefined {
    return changes.find((change: StructureChangeInfo) => change.after?.name === name);
}

function byBeforeName(changes: readonly StructureChangeInfo[], name: string): StructureChangeInfo | undefined {
    return changes.find((change: StructureChangeInfo) => change.before?.name === name);
}

describe("structural inference from history toward SSOT", () => {
    it("classifies nullable additions as preserving and NOT NULL additions as requiring data proof", () => {
        const from = schema([table("people"), column("people", "id", false)]);
        const to = schema([
            table("people"),
            column("people", "id", false),
            column("people", "nickname", true),
            column("people", "code", false),
        ]);

        const changes = infer(from, to);
        const nickname = byAfterName(changes, "nickname");
        const code = byAfterName(changes, "code");

        assert.ok(nickname);
        assert.equal(nickname.action, "add");
        assert.equal(nickname.origin, "inferred");
        assert.equal(nickname.impact, "preserving");

        assert.ok(code);
        assert.equal(code.action, "add");
        assert.equal(code.origin, "inferred");
        assert.equal(code.impact, "requiresDataCheck");
    });

    it("does not guess renames, but honors an explicit bijective field correspondence", () => {
        const from = schema([
            table("people"),
            column("people", "id", false),
            column("people", "old_name", true),
        ]);
        const to = schema([
            table("people"),
            column("people", "id", false),
            column("people", "new_name", true),
        ]);

        const unassisted = infer(from, to);
        const removed = byBeforeName(unassisted, "old_name");
        const added = byAfterName(unassisted, "new_name");
        assert.ok(removed);
        assert.equal(removed.action, "remove");
        assert.equal(removed.impact, "destructive");
        assert.ok(added);
        assert.equal(added.action, "add");
        assert.equal(added.impact, "preserving");
        assert.equal(unassisted.some((change: StructureChangeInfo) => change.action === "rename"), false);

        const explicitRename: RenameInfo = {
            before: {side: "from", entity: "people", field: "old_name"},
            after: {side: "to", entity: "people", field: "new_name"},
        };
        const assisted = infer(from, to, [explicitRename]);
        assert.equal(assisted.length, 1);
        assert.equal(assisted[0]?.action, "rename");
        assert.equal(assisted[0]?.impact, "preserving");
    });

    it("classifies tightening nullability as data-sensitive, loosening it as preserving, and drops as destructive", () => {
        const nullable = schema([
            table("people"),
            column("people", "id", false),
            column("people", "name", true),
            column("people", "legacy", true),
        ]);
        const tightened = schema([
            table("people"),
            column("people", "id", false),
            column("people", "name", false),
        ]);

        const forward = infer(nullable, tightened);
        const nameTightened = byAfterName(forward, "name");
        const legacyDrop = byBeforeName(forward, "legacy");
        assert.ok(nameTightened);
        assert.equal(nameTightened.action, "alter");
        assert.equal(nameTightened.impact, "requiresDataCheck");
        assert.ok(legacyDrop);
        assert.equal(legacyDrop.action, "remove");
        assert.equal(legacyDrop.impact, "destructive");

        const loosened = infer(
            schema([table("people"), column("people", "id", false), column("people", "name", false)]),
            schema([table("people"), column("people", "id", false), column("people", "name", true)]),
        );
        const nameLoosened = byAfterName(loosened, "name");
        assert.ok(nameLoosened);
        assert.equal(nameLoosened.action, "alter");
        assert.equal(nameLoosened.impact, "preserving");
    });

    it("produces deterministic change ids/order and binds ids to the historical base", () => {
        const from = schema([table("people"), column("people", "id", false)]);
        const targetObjects = [
            table("people"),
            column("people", "id", false),
            column("people", "beta", true),
            column("people", "alpha", true),
        ];
        const first = infer(from, schema(targetObjects));
        const reordered = infer(from, schema([...targetObjects].reverse()));

        assert.deepEqual(
            first.map((change: StructureChangeInfo) => change.id),
            reordered.map((change: StructureChangeInfo) => change.id),
        );
        assert.equal(new Set(first.map((change: StructureChangeInfo) => change.id)).size, first.length);
        assert.ok(first.every((change: StructureChangeInfo) => change.id.length > 0));

        const otherBase: AuthoringBaseInfo = {...base, toSnapshotHash: "7".repeat(64)};
        const rebound = infer(from, schema(targetObjects), [], otherBase);
        assert.notDeepEqual(
            first.map((change: StructureChangeInfo) => change.id),
            rebound.map((change: StructureChangeInfo) => change.id),
        );
    });
});

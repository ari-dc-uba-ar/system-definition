import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {
    canonicalJson,
    toJsonValue,
    type FileInfo,
    type JsonValue,
    type MigrationInfo,
    type MigrationPathInfo,
    type PublishedMigrationInfo,
} from "system-definition";
import {
    computeMigrationHash,
    type ArtifactResult,
    type MigrationManifestInfo,
} from "../src/artifact";
import {
    buildMigrationPlan,
    computePlanHash,
    type MigrationPlanArtifactContext,
} from "../src/migration-plan";
import type {CompiledAuthoringInfo} from "../src/authoring";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);
const encoder = new TextEncoder();

const from = {systemId: "demo", releaseId: "A", releaseHash: H1} as const;
const to = {systemId: "demo", releaseId: "B", releaseHash: H2} as const;

function migration(): MigrationInfo {
    return {id: "A-B", from, to, description: "A to B", before: [], steps: [], after: []};
}

function authoring(migrationValue: MigrationInfo = migration()): CompiledAuthoringInfo {
    return {
        formatVersion: 1,
        draftHash: H3,
        base: {
            from,
            to,
            fromSnapshotHash: H1,
            toSnapshotHash: H2,
            fromPersistenceHash: H3,
            toPersistenceHash: H4,
        },
        migration: migrationValue,
        operations: [],
        decisions: [],
        checkpoints: [],
        queryResources: {},
        validationArtifacts: [],
    };
}

function bytesOf(value: unknown): Uint8Array {
    const json = toJsonValue(value);
    if (!json.ok) throw new Error("fixture is not strict JSON");
    return encoder.encode(canonicalJson(json.value));
}

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function manifest(authoringBytes: Uint8Array = bytesOf(authoring())): MigrationManifestInfo {
    const value: MigrationManifestInfo = {
        formatVersion: 1,
        migration: migration(),
        authoring: {
            path: "authoring.json",
            contentHash: sha256(authoringBytes),
            byteLength: authoringBytes.byteLength,
        },
        migrationHash: "0".repeat(64),
    };
    value.migrationHash = computeMigrationHash(value);
    return value;
}

function published(value: MigrationManifestInfo): PublishedMigrationInfo {
    return {migration: value.migration, migrationHash: value.migrationHash};
}

function path(one: PublishedMigrationInfo): MigrationPathInfo {
    return {from, to, migrations: [one]};
}

function ok<T>(value: T): ArtifactResult<T> {
    return {ok: true, value};
}

class MemoryContext implements MigrationPlanArtifactContext {
    readonly manifests = new Map<string, JsonValue>();
    readonly files = new Map<string, Uint8Array>();
    manifestReads = 0;
    fileReads = 0;

    async loadMigrationManifest(one: PublishedMigrationInfo): Promise<ArtifactResult<JsonValue>> {
        this.manifestReads++;
        const found = this.manifests.get(one.migrationHash);
        return found === undefined
            ? {ok: false, problems: [{field: null, messageKey: "migration.invalidReference", message: "migration.invalidReference", severity: "blocking", details: {}}]}
            : ok(found);
    }

    async readMigrationFile(one: PublishedMigrationInfo, file: FileInfo): Promise<ArtifactResult<Uint8Array>> {
        this.fileReads++;
        const found = this.files.get(one.migrationHash + ":" + file.path);
        return found === undefined
            ? {ok: false, problems: [{field: null, messageKey: "migration.invalidReference", message: "migration.invalidReference", severity: "blocking", details: {}}]}
            : ok(found);
    }
}

function install(context: MemoryContext, value: MigrationManifestInfo, authoringBytes = bytesOf(authoring())): PublishedMigrationInfo {
    const one = published(value);
    const json = toJsonValue(value);
    if (!json.ok) throw new Error("manifest fixture is not strict JSON");
    context.manifests.set(one.migrationHash, json.value);
    context.files.set(one.migrationHash + ":authoring.json", authoringBytes);
    return one;
}

function firstKey(result: {ok: boolean; problems?: readonly {messageKey: string}[]}): string | undefined {
    return result.ok ? undefined : result.problems?.[0]?.messageKey;
}

describe("T22 artifact-backed migration plan and planHash", () => {
    it("hashes the complete plan except planHash itself", () => {
        const one = manifest();
        const base = {formatVersion: 1 as const, from, to, migrations: [published(one)], planHash: "0".repeat(64)};
        assert.equal(computePlanHash(base), computePlanHash({...base, planHash: "f".repeat(64)}));
        assert.notEqual(computePlanHash(base), computePlanHash({...base, migrations: [{...published(one), migrationHash: "e".repeat(64)}]}));
    });

    it("builds an empty plan without consulting migration artifacts", async () => {
        const context = new MemoryContext();
        const result = await buildMigrationPlan({from, to: from, migrations: []}, context);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.from, from);
        assert.deepEqual(result.value.to, from);
        assert.deepEqual(result.value.migrations, []);
        assert.equal(result.value.planHash, computePlanHash(result.value));
        assert.equal(context.manifestReads, 0);
        assert.equal(context.fileReads, 0);
    });

    it("loads the immutable manifest and exact authoring bytes before signing the plan", async () => {
        const context = new MemoryContext();
        const authoringBytes = bytesOf(authoring());
        const value = manifest(authoringBytes);
        const one = install(context, value, authoringBytes);
        const result = await buildMigrationPlan(path(one), context);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.migrations, [one]);
        assert.equal(result.value.planHash, computePlanHash(result.value));
        assert.equal(context.manifestReads, 1);
        assert.equal(context.fileReads, 1);
    });

    it("rejects missing, changed or non-canonical authoring bytes", async () => {
        const missingContext = new MemoryContext();
        const value = manifest();
        const one = published(value);
        const json = toJsonValue(value);
        if (!json.ok) throw new Error("manifest fixture is not strict JSON");
        missingContext.manifests.set(one.migrationHash, json.value);
        assert.equal(firstKey(await buildMigrationPlan(path(one), missingContext)), "migration.invalidReference");

        const changedContext = new MemoryContext();
        const changedOne = install(changedContext, value, encoder.encode("{}"));
        assert.equal(firstKey(await buildMigrationPlan(path(changedOne), changedContext)), "migration.checksumMismatch");

        const nonCanonical = encoder.encode(JSON.stringify(authoring(), null, 2));
        const nonCanonicalManifest = manifest(nonCanonical);
        const nonCanonicalContext = new MemoryContext();
        const nonCanonicalOne = install(nonCanonicalContext, nonCanonicalManifest, nonCanonical);
        assert.equal(firstKey(await buildMigrationPlan(path(nonCanonicalOne), nonCanonicalContext)), "migration.checksumMismatch");
    });

    it("rejects a manifest/path disagreement and an authoring base that is not the migration endpoints", async () => {
        const context = new MemoryContext();
        const value = manifest();
        const one = install(context, value);
        const wrongPublished = {...one, migration: {...one.migration, id: "different-id"}};
        assert.equal(firstKey(await buildMigrationPlan(path(wrongPublished), context)), "migration.checksumMismatch");

        const wrongAuthoring = authoring();
        wrongAuthoring.base = {...wrongAuthoring.base, to: {...to, releaseId: "C"}};
        const wrongBytes = bytesOf(wrongAuthoring);
        const wrongManifest = manifest(wrongBytes);
        const wrongContext = new MemoryContext();
        const wrongOne = install(wrongContext, wrongManifest, wrongBytes);
        assert.equal(firstKey(await buildMigrationPlan(path(wrongOne), wrongContext)), "migration.invalidReference");
    });
});

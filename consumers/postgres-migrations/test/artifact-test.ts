import {strict as assert} from "node:assert";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {
    computeReleaseHash,
    loadReleaseArtifact,
    publishReleaseArtifact,
    sha256Hex,
    type ReleaseArtifactDraft,
    type ReleaseManifestInfo,
} from "../src/artifact";

const ZERO_HASH = "0".repeat(64);

function draft(releaseId = "aida_001"): ReleaseArtifactDraft {
    return {
        systemId: "aida",
        releaseId,
        snapshot: {
            formatVersion: 1,
            systemId: "aida",
            typeNames: ["texto"],
            entities: {},
            records: {},
        },
        persistence: {
            entities: [],
            representations: {postgresql: {texto: "text"}},
        },
        schema: {formatVersion: 1, schemas: {app: {}}},
        createPlan: {formatVersion: 1, schema: "app", generatedSql: [], extraResources: [], dataResources: [], after: []},
        resources: {
            "create-core": {kind: "sql", path: "resources/create-core.sql", text: "select 1;\n"},
            "invariant-core": {kind: "check", path: "resources/invariant-core.sql", text: "select true;\n"},
        },
        invariantChecks: ["invariant-core"],
        managedData: [],
        environment: {
            engine: "postgresql",
            version: "18.6",
            serverVersionNum: 180006,
            encoding: "UTF8",
            collations: {},
            externalDependencies: {},
        },
        generator: {name: "fixture-generator", version: "1", contentHash: ZERO_HASH},
        inspector: {name: "fixture-inspector", version: "1", contentHash: ZERO_HASH},
    };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "system-definition-artifact-"));
    try {
        await run(dir);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

function blockingKey(result: {ok: boolean, problems?: readonly {message: string}[]}): string | undefined {
    return result.ok ? undefined : result.problems?.[0]?.message;
}

describe("immutable release artifacts", () => {
    it("hashes exact bytes with lowercase SHA-256 and does not normalize SQL", () => {
        const lf = new TextEncoder().encode("select 1;\n");
        const crlf = new TextEncoder().encode("select 1;\r\n");
        assert.match(sha256Hex(lf), /^[0-9a-f]{64}$/);
        assert.notEqual(sha256Hex(lf), sha256Hex(crlf));
    });

    it("computes releaseHash without a self-hash cycle and still covers semantic manifest fields", () => {
        const base = {
            formatVersion: 1,
            release: {systemId: "aida", releaseId: "aida_001", releaseHash: ZERO_HASH},
            snapshot: {path: "snapshot.json", contentHash: ZERO_HASH, byteLength: 1},
            snapshotHash: ZERO_HASH,
            persistence: {path: "persistence.json", contentHash: ZERO_HASH, byteLength: 1},
            schema: {path: "schema.json", contentHash: ZERO_HASH, byteLength: 1},
            schemaHash: ZERO_HASH,
            createPlan: {path: "create-plan.json", contentHash: ZERO_HASH, byteLength: 1},
            resources: {},
            invariantChecks: [],
            managedData: [],
            environment: {
                engine: "postgresql",
                version: "18.6",
                serverVersionNum: 180006,
                encoding: "UTF8",
                collations: {},
                externalDependencies: {},
            },
            generator: {name: "g", version: "1", contentHash: ZERO_HASH},
            inspector: {name: "i", version: "1", contentHash: ZERO_HASH},
        } as ReleaseManifestInfo;
        const changedSelf = {...base, release: {...base.release, releaseHash: "f".repeat(64)}};
        const changedEnvironment = {...base, environment: {...base.environment, encoding: "LATIN1"}};
        assert.equal(computeReleaseHash(base), computeReleaseHash(changedSelf));
        assert.notEqual(computeReleaseHash(base), computeReleaseHash(changedEnvironment));
    });

    it("publishes idempotently but refuses the same release id with different content", async () => {
        await withTempDir(async root => {
            const first = await publishReleaseArtifact(root, draft());
            assert.equal(first.ok, true);
            const repeated = await publishReleaseArtifact(root, draft());
            assert.equal(repeated.ok, true);

            const changed = draft();
            changed.resources["create-core"] = {...changed.resources["create-core"], text: "select 2;\n"};
            const conflict = await publishReleaseArtifact(root, changed);
            assert.equal(conflict.ok, false);

            const loaded = await loadReleaseArtifact(join(root, "releases", "aida_001"));
            assert.equal(loaded.ok, true);
            if (loaded.ok) assert.equal(loaded.value.resources["create-core"].text, "select 1;\n");
        });
    });

    it("detects one changed SQL byte before returning a loadable artifact", async () => {
        await withTempDir(async root => {
            const published = await publishReleaseArtifact(root, draft());
            assert.equal(published.ok, true);
            const dir = join(root, "releases", "aida_001");
            await writeFile(join(dir, "resources", "create-core.sql"), "select 2;\n", "utf8");
            const loaded = await loadReleaseArtifact(dir);
            assert.equal(loaded.ok, false);
            assert.equal(blockingKey(loaded), "migration.checksumMismatch");
        });
    });

    it("rejects absolute paths, parent escapes and case-colliding artifact paths", async () => {
        await withTempDir(async root => {
            const absolute = draft("absolute");
            absolute.resources["create-core"] = {...absolute.resources["create-core"], path: join(root, "escape.sql")};
            assert.equal((await publishReleaseArtifact(root, absolute)).ok, false);

            const parent = draft("parent");
            parent.resources["create-core"] = {...parent.resources["create-core"], path: "../escape.sql"};
            assert.equal((await publishReleaseArtifact(root, parent)).ok, false);

            const collision = draft("collision");
            collision.resources["other"] = {kind: "sql", path: "resources/CREATE-CORE.sql", text: "select 2;\n"};
            assert.equal((await publishReleaseArtifact(root, collision)).ok, false);
        });
    });

    it("rejects symlink escapes while loading", async () => {
        await withTempDir(async root => {
            const published = await publishReleaseArtifact(root, draft());
            assert.equal(published.ok, true);
            const dir = join(root, "releases", "aida_001");
            const outside = join(root, "outside.sql");
            await writeFile(outside, "select 1;\n", "utf8");
            const resource = join(dir, "resources", "create-core.sql");
            await rm(resource);
            await symlink(outside, resource);
            const loaded = await loadReleaseArtifact(dir);
            assert.equal(loaded.ok, false);
        });
    });

    it("rejects BOM/CRLF SQL instead of rewriting published bytes", async () => {
        await withTempDir(async root => {
            const bom = draft("bom");
            bom.resources["create-core"] = {...bom.resources["create-core"], text: "\uFEFFselect 1;\n"};
            assert.equal((await publishReleaseArtifact(root, bom)).ok, false);

            const crlf = draft("crlf");
            crlf.resources["create-core"] = {...crlf.resources["create-core"], text: "select 1;\r\n"};
            assert.equal((await publishReleaseArtifact(root, crlf)).ok, false);
        });
    });

    it("loads the published historical snapshot instead of consulting a live Def", async () => {
        await withTempDir(async root => {
            const source = draft();
            const published = await publishReleaseArtifact(root, source);
            assert.equal(published.ok, true);
            source.snapshot.systemId = "mutated-live-definition";
            source.persistence.representations.postgresql.texto = "varchar";

            const loaded = await loadReleaseArtifact(join(root, "releases", "aida_001"));
            assert.equal(loaded.ok, true);
            if (loaded.ok) {
                assert.equal(loaded.value.snapshot.systemId, "aida");
                assert.equal(loaded.value.persistence.representations.postgresql.texto, "text");
            }
        });
    });

    it("rejects a manifest whose own release hash or file metadata was edited", async () => {
        await withTempDir(async root => {
            const published = await publishReleaseArtifact(root, draft());
            assert.equal(published.ok, true);
            const dir = join(root, "releases", "aida_001");
            const manifestPath = join(dir, "manifest.json");
            const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseManifestInfo;
            manifest.release.releaseHash = "f".repeat(64);
            await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
            const loaded = await loadReleaseArtifact(dir);
            assert.equal(loaded.ok, false);
            assert.equal(blockingKey(loaded), "migration.checksumMismatch");
        });
    });
});

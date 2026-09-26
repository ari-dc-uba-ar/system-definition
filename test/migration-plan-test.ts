import * as assert from "assert";
import type {Problem, ValidationResult} from "../src/common/problem";
import {completeMigration} from "../src/common/migration";
import type {MigrationInfo, ReleaseRefInfo} from "../src/common/migration";
import {
    completeMigrationCatalog,
    resolveMigrationPath,
    type MigrationCatalogInfo,
    type PublishedMigrationInfo,
} from "../src/common/migration-plan";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_AB = "1111111111111111111111111111111111111111111111111111111111111111";
const HASH_BC = "2222222222222222222222222222222222222222222222222222222222222222";

const releaseA = {systemId: "aida", releaseId: "aida_001", releaseHash: HASH_A} as const;
const releaseB = {systemId: "aida", releaseId: "aida_002", releaseHash: HASH_B} as const;
const releaseC = {systemId: "aida", releaseId: "aida_003", releaseHash: HASH_C} as const;

const migrationContext = {
    releases: {
        aida_001: releaseA,
        aida_002: releaseB,
        aida_003: releaseC,
    },
    resources: {
        data_backfill_v1: {
            kind: "sql",
            file: {
                path: "sql/data-backfill-v1.sql",
                contentHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                byteLength: 10,
            },
        },
    },
} as const;

function migrationInfo(
    id: string,
    from: "aida_001" | "aida_002",
    to: "aida_002" | "aida_003",
    steps: readonly {id: string, run: "data_backfill_v1"}[],
    description = "",
): MigrationInfo {
    const result = completeMigration(migrationContext, {
        id,
        from,
        to,
        description,
        steps,
    } as never);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("migration fixture did not complete");
    return result.value;
}

function publishedFixtures(): readonly [PublishedMigrationInfo, PublishedMigrationInfo] {
    return [
        {
            migration: migrationInfo("aida_001_to_002", "aida_001", "aida_002", [
                {id: "backfill", run: "data_backfill_v1"},
            ]),
            migrationHash: HASH_AB,
        },
        {
            migration: migrationInfo("aida_002_to_003", "aida_002", "aida_003", [], "metadata only"),
            migrationHash: HASH_BC,
        },
    ];
}

function validCatalog(): MigrationCatalogInfo {
    const result = completeMigrationCatalog([releaseA, releaseB, releaseC], publishedFixtures());
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("catalog fixture did not complete");
    return result.value;
}

function assertInvalid<T>(result: ValidationResult<T>, expectedKey?: string): void {
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.problems.some((one: Problem) => one.severity === "blocking"));
    if (expectedKey !== undefined) {
        assert.ok(result.problems.some((one: Problem) => one.messageKey === expectedKey));
    }
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

describe("linear migration catalog", function () {
    it("completes a contiguous catalog and resolves A→C as A→B,B→C", function () {
        const catalogResult = completeMigrationCatalog([releaseA, releaseB, releaseC], publishedFixtures());
        assert.equal(catalogResult.ok, true);
        if (!catalogResult.ok) return;
        assert.equal(catalogResult.value.systemId, "aida");

        const path = resolveMigrationPath(catalogResult.value, "aida_001", "aida_003");
        assert.equal(path.ok, true);
        if (!path.ok) return;
        assert.deepEqual(path.value.from, releaseA);
        assert.deepEqual(path.value.to, releaseC);
        assert.deepEqual(path.value.migrations.map((one: PublishedMigrationInfo) => one.migration.id), [
            "aida_001_to_002",
            "aida_002_to_003",
        ]);
    });

    it("preserves from/to on an empty A→A path", function () {
        const path = resolveMigrationPath(validCatalog(), "aida_002", "aida_002");
        assert.equal(path.ok, true);
        if (!path.ok) return;
        assert.deepEqual(path.value.from, releaseB);
        assert.deepEqual(path.value.to, releaseB);
        assert.deepEqual(path.value.migrations, []);
    });

    it("accepts data-only and metadata-only transitions without inferring schema changes", function () {
        const result = completeMigrationCatalog([releaseA, releaseB, releaseC], publishedFixtures());
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.value.migrations[0].migration.steps.length, 1);
        assert.equal(result.value.migrations[1].migration.steps.length, 0);
        assert.equal(result.value.migrations[1].migration.description, "metadata only");
    });

    it("accepts a one-release baseline but rejects an empty catalog", function () {
        const baseline = completeMigrationCatalog([releaseA], []);
        assert.equal(baseline.ok, true);
        if (baseline.ok) {
            assert.equal(baseline.value.systemId, "aida");
            assert.deepEqual(baseline.value.migrations, []);
        }
        assertInvalid(completeMigrationCatalog([], []), "migration.invalidCatalog");
    });

    it("rejects gaps, forks, duplicate releases, duplicate migrations, and self edges", function () {
        const [ab, bc] = publishedFixtures();

        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB, releaseC], [ab]),
            "migration.invalidCatalog",
        );

        const fork = clone(bc) as PublishedMigrationInfo;
        (fork.migration as {from: ReleaseRefInfo}).from = clone(releaseA);
        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB, releaseC], [ab, fork]),
            "migration.invalidCatalog",
        );

        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB, releaseB], [ab, bc]),
            "migration.invalidCatalog",
        );

        const duplicateId = clone(bc) as PublishedMigrationInfo;
        (duplicateId.migration as {id: string}).id = ab.migration.id;
        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB, releaseC], [ab, duplicateId]),
            "migration.invalidCatalog",
        );

        const selfEdge = clone(ab) as PublishedMigrationInfo;
        (selfEdge.migration as {to: ReleaseRefInfo}).to = clone(releaseA);
        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB], [selfEdge]),
            "migration.invalidCatalog",
        );
    });

    it("rejects discordant systems and malformed release/migration hashes", function () {
        const [ab, bc] = publishedFixtures();
        const otherC = {...releaseC, systemId: "other"};
        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB, otherC], [ab, bc]),
            "migration.invalidCatalog",
        );

        const badRelease = {...releaseB, releaseHash: "NOT-A-SHA256"};
        assertInvalid(
            completeMigrationCatalog([releaseA, badRelease], [ab]),
            "migration.invalidCatalog",
        );

        const badMigrationHash = {...ab, migrationHash: "ABC"};
        assertInvalid(
            completeMigrationCatalog([releaseA, releaseB], [badMigrationHash]),
            "migration.invalidCatalog",
        );
    });

    it("rejects unknown origins/destinations and downgrades with the documented message keys", function () {
        const catalog = validCatalog();
        assertInvalid(resolveMigrationPath(catalog, "missing", "aida_003"), "migration.invalidReference");
        assertInvalid(resolveMigrationPath(catalog, "aida_001", "missing"), "migration.invalidReference");
        assertInvalid(resolveMigrationPath(catalog, "aida_003", "aida_001"), "migration.downgradeUnsupported");
    });

    it("returns a detached completed catalog and keeps hashing out of the pure path", function () {
        const releases = [clone(releaseA), clone(releaseB), clone(releaseC)] as unknown as {systemId: string, releaseId: string, releaseHash: string}[];
        const migrations = clone(publishedFixtures()) as unknown as PublishedMigrationInfo[];
        const result = completeMigrationCatalog(releases, migrations);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        releases[0].releaseId = "changed";
        migrations[0].migration.id = "changed";
        assert.equal(result.value.releases[0].releaseId, "aida_001");
        assert.equal(result.value.migrations[0].migration.id, "aida_001_to_002");

        const path = resolveMigrationPath(result.value, "aida_001", "aida_003");
        assert.equal(path.ok, true);
        if (!path.ok) return;
        assert.equal(path.value.from.releaseId, "aida_001");
        assert.equal("planHash" in path.value, false);
    });
});

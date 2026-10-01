import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {FileInfo, JsonValue, MigrationInfo} from "system-definition";
import {
    computeMigrationHash,
    decodeMigrationManifest,
} from "../src/artifact";

const ZERO_HASH = "0".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const from = {systemId: "aida", releaseId: "aida_001", releaseHash: HASH_A} as const;
const to = {systemId: "aida", releaseId: "aida_002", releaseHash: HASH_B} as const;

function migration(): MigrationInfo {
    return {
        id: "aida_001_to_002",
        from,
        to,
        description: "generated and authored migration",
        before: [],
        steps: [],
        after: [],
    };
}

type MigrationManifestFixture = {
    formatVersion: 1;
    migration: MigrationInfo;
    authoring: FileInfo;
    migrationHash: string;
};

function fixture(): MigrationManifestFixture {
    return {
        formatVersion: 1,
        migration: migration(),
        authoring: {
            path: "authoring.json",
            contentHash: "c".repeat(64),
            byteLength: 321,
        },
        migrationHash: ZERO_HASH,
    };
}

function validFixture(): MigrationManifestFixture {
    const value = fixture();
    value.migrationHash = computeMigrationHash(value);
    return value;
}

function jsonClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function firstProblem(result: {ok: boolean; problems?: readonly {messageKey: string; details?: Readonly<Record<string, string>>}[]}): {messageKey: string; details?: Readonly<Record<string, string>>} | undefined {
    return result.ok ? undefined : result.problems?.[0];
}

describe("T22 immutable migration authoring manifest and hash", () => {
    it("hashes the complete migration manifest except for migrationHash itself", () => {
        const base = fixture();
        const changedSelf = {...base, migrationHash: "f".repeat(64)};
        const changedAuthoring = {
            ...base,
            authoring: {...base.authoring, contentHash: "d".repeat(64)},
        };

        assert.equal(computeMigrationHash(base), computeMigrationHash(changedSelf));
        assert.notEqual(computeMigrationHash(base), computeMigrationHash(changedAuthoring));
    });

    it("decodes a manifest only when authoring FileInfo is present and returns a detached copy", () => {
        const source = validFixture();
        const decoded = decodeMigrationManifest(source as unknown as JsonValue);
        assert.equal(decoded.ok, true);
        if (!decoded.ok) return;

        source.authoring.path = "mutated-after-decode.json";
        source.migration.description = "mutated after decode";
        assert.equal(decoded.value.authoring.path, "authoring.json");
        assert.equal(decoded.value.migration.description, "generated and authored migration");
    });

    it("rejects a legacy migration-only manifest instead of making authoring optional", () => {
        const source = validFixture() as unknown as Record<string, unknown>;
        delete source.authoring;
        const decoded = decodeMigrationManifest(source as unknown as JsonValue);
        assert.equal(decoded.ok, false);
        assert.equal(firstProblem(decoded)?.messageKey, "migration.unsupportedFormat");
    });

    it("rejects malformed authoring file metadata at the artifact boundary", () => {
        const source = validFixture();
        const unsafe = jsonClone(source);
        unsafe.authoring.path = "../authoring.json";
        unsafe.migrationHash = computeMigrationHash(unsafe);
        const badPath = decodeMigrationManifest(unsafe as unknown as JsonValue);
        assert.equal(badPath.ok, false);
        assert.equal(firstProblem(badPath)?.messageKey, "migration.invalidReference");

        const malformed = jsonClone(source);
        malformed.authoring.contentHash = "NOT-A-HASH";
        const badHash = decodeMigrationManifest(malformed as unknown as JsonValue);
        assert.equal(badHash.ok, false);
        assert.equal(firstProblem(badHash)?.messageKey, "migration.unsupportedFormat");
    });

    it("rejects a stale migrationHash when the authoring artifact reference changes", () => {
        const source = validFixture();
        source.authoring.contentHash = "e".repeat(64);
        const decoded = decodeMigrationManifest(source as unknown as JsonValue);
        assert.equal(decoded.ok, false);
        assert.equal(firstProblem(decoded)?.messageKey, "migration.checksumMismatch");
    });
});

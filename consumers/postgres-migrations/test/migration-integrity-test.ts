import {strict as assert} from "node:assert";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import {AuthoringFiles} from "../src/authoring-files";
import {canonicalBytes, computeMigrationHash, sha256Hex} from "../src/artifact";
import {createMigrationManifest} from "../src/migration-artifact";
import {publishArtifactDirectory} from "../src/artifact-files";
import {verifyMigrationFiles} from "../src/migration-integrity";
import type {CompiledAuthoringInfo} from "../src/authoring-contract";
import type {ValidationArtifactInfo} from "../src/validation-artifact";

function value<T>(result: ValidationResult<T>): T {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;}
async function fixture(directory: string) {
    const files = new AuthoringFiles();
    const resource = async <TKind extends "sql" | "check" | "query">(name: string, kind: TKind, text: string) => {
        const ref = {name, kind, contentHash: sha256Hex(new TextEncoder().encode(text))};
        const file = value(await files.emitResource({ref, text}));
        return {ref, file};
    };
    const before = await resource("before", "check", "SELECT true AS ok;\n");
    const transform = await resource("transform", "sql", "SELECT 1;\n");
    const after = await resource("after", "check", "SELECT true AS ok /*after*/;\n");
    const checkpoint = await resource("checkpoint", "check", "SELECT true AS ok /*checkpoint*/;\n");
    const query = await resource("rows", "query", "SELECT 1 AS id;\n");
    const unused = await resource("original-source", "query", "SELECT 2 AS id;\n");
    const code = new TextEncoder().encode('throw new Error("Verifier must not import validator modules");\n');
    const entry = {path: "validators/code.mjs", contentHash: sha256Hex(code), byteLength: code.length};
    files.files.set(entry.path, code);
    const from = {systemId: "integrity", releaseId: "A", releaseHash: "1".repeat(64)}, to = {...from, releaseId: "B", releaseHash: "2".repeat(64)};
    const validator: ValidationArtifactInfo = {formatVersion: 1, side: "from", snapshotHash: "3".repeat(64), entry,
        runtime: {nodeVersion: process.version, abi: "migration-validation-1"}, domainContractHashes: {}, entityValidatorNames: {}};
    const compiled: CompiledAuthoringInfo = {formatVersion: 1, draftHash: "4".repeat(64),
        base: {from, to, fromSnapshotHash: validator.snapshotHash, toSnapshotHash: "5".repeat(64), fromPersistenceHash: "6".repeat(64), toPersistenceHash: "7".repeat(64)},
        migration: {id: "A-B", from, to, description: "", before: [before.ref], steps: [{id: "transform", run: transform.ref}], after: [after.ref]},
        operations: [], decisions: [], checkpoints: [{afterStep: "transform", checks: [checkpoint.ref], rows: []}],
        queryResources: {rows: {kind: "query", file: query.file}}, validationArtifacts: [validator]};
    const manifest = value(createMigrationManifest(compiled, files));
    const saved = new Map(files.files); saved.set("migration.json", value(canonicalBytes(manifest)).bytes);
    await publishArtifactDirectory(directory, saved);
    const published = {migration: manifest.migration, migrationHash: manifest.migrationHash};
    return {published, paths: ["authoring.json", "resources.json", before.file.path, transform.file.path, after.file.path, checkpoint.file.path, query.file.path, unused.file.path, entry.path]};
}

describe("migration file integrity", () => {
    it("checks every bound file without running SQL or importing validator code", async () => {
        const root = await mkdtemp(join(tmpdir(), "sd-file-integrity-"));
        try {
            const directory = join(root, "migration"), saved = await fixture(directory);
            assert.equal((await verifyMigrationFiles(directory, saved.published)).ok, true);
            for (const path of saved.paths) {
                const target = join(directory, path), original = await readFile(target), changed = new Uint8Array(original);
                changed[0] = changed[0] ^ 1;
                await writeFile(target, changed);
                const verified = await verifyMigrationFiles(directory, saved.published);
                assert.equal(verified.ok, false, path);
                if (!verified.ok) assert.equal(verified.problems[0]?.messageKey, "migration.checksumMismatch", path);
                await writeFile(target, original);
            }
            assert.equal((await verifyMigrationFiles(directory, saved.published)).ok, true);
            const missing = join(directory, saved.paths[3]);
            await rm(missing);
            assert.equal((await verifyMigrationFiles(directory, saved.published)).ok, false);
        } finally {await rm(root, {recursive: true, force: true});}
    });
    it("rejects a rewritten manifest even when its new self-hash is valid", async () => {
        const root = await mkdtemp(join(tmpdir(), "sd-file-manifest-"));
        try {
            const directory = join(root, "migration"), saved = await fixture(directory);
            const path = join(directory, "migration.json"), manifest = JSON.parse(await readFile(path, "utf8"));
            manifest.migration.description = "edited";
            manifest.migrationHash = computeMigrationHash(manifest);
            await writeFile(path, value(canonicalBytes(manifest)).bytes);
            const checked = await verifyMigrationFiles(directory, saved.published);
            assert.equal(checked.ok, false);
            if (!checked.ok) assert.equal(checked.problems[0]?.messageKey, "migration.checksumMismatch");
        } finally {await rm(root, {recursive: true, force: true});}
    });
    it("verifies legacy pretty manifests without a registry FileInfo", async () => {
        const root = await mkdtemp(join(tmpdir(), "sd-file-legacy-"));
        try {
            const directory = join(root, "migration");
            await fixture(directory);
            const path = join(directory, "migration.json"), manifest = JSON.parse(await readFile(path, "utf8"));
            delete manifest.resources;
            manifest.migrationHash = computeMigrationHash(manifest);
            await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
            assert.equal((await verifyMigrationFiles(directory, {migration: manifest.migration, migrationHash: manifest.migrationHash})).ok, true);
        } finally {await rm(root, {recursive: true, force: true});}
    });
});

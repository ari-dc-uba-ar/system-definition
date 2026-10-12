import {strict as assert} from "node:assert";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import type {MigrationCatalogInfo, ReleaseRefInfo, ValidationResult} from "system-definition";
import {readMigrationCatalog} from "../src/migration-catalog";
import {createMigrationManifest} from "../src/migration-artifact";
import {publishArtifactDirectory} from "../src/artifact-files";
import {AuthoringFiles} from "../src/authoring-files";
import {canonicalBytes, sha256Hex} from "../src/artifact";
import type {CompiledAuthoringInfo} from "../src/authoring-contract";

const ref = (id: string, digit: string): ReleaseRefInfo => ({systemId: "catalog", releaseId: id, releaseHash: digit.repeat(64)});
const A = ref("A", "1"), B = ref("B", "2"), C = ref("C", "3");
function value<T>(result: ValidationResult<T>): T {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;}
async function save(directory: string, from: ReleaseRefInfo, to: ReleaseRefInfo) {
    const files = new AuthoringFiles(), text = "SELECT 1;\n";
    const run = {kind: "sql" as const, name: "run.sql", contentHash: sha256Hex(new TextEncoder().encode(text))};
    value(await files.emitResource({ref: run, text}));
    const compiled: CompiledAuthoringInfo = {formatVersion: 1, draftHash: "4".repeat(64),
        base: {from, to, fromSnapshotHash: "5".repeat(64), toSnapshotHash: "6".repeat(64), fromPersistenceHash: "7".repeat(64), toPersistenceHash: "8".repeat(64)},
        migration: {id: from.releaseId + "-" + to.releaseId, from, to, description: "", before: [], steps: [{id: "run", run}], after: []},
        operations: [], decisions: [], checkpoints: [], queryResources: {}, validationArtifacts: []};
    const manifest = value(createMigrationManifest(compiled, files));
    const saved = new Map(files.files); saved.set("migration.json", value(canonicalBytes(manifest)).bytes);
    await publishArtifactDirectory(directory, saved);
    return {migration: manifest.migration, migrationHash: manifest.migrationHash};
}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Contract = Expect<Equal<typeof readMigrationCatalog, (baseline: ReleaseRefInfo, directories: readonly string[]) => Promise<ValidationResult<MigrationCatalogInfo>>>>;
const contract: Contract = true;

describe("saved migration catalog reading", () => {
    it("reads the explicit sequence without sorting directory names or altering files", async () => {
        assert.equal(contract, true);
        const directory = await mkdtemp(join(tmpdir(), "sd-catalog-"));
        try {
            const first = join(directory, "z-first"), second = join(directory, "a-second");
            const AB = await save(first, A, B), BC = await save(second, B, C);
            const before = await readFile(join(first, "migration.json"), "utf8");
            const catalog = value(await readMigrationCatalog(A, [first, second]));
            assert.deepEqual(catalog.migrations.map(entry => entry.migrationHash), [AB.migrationHash, BC.migrationHash]);
            assert.deepEqual(catalog.releases.map(release => release.releaseId), ["A", "B", "C"]);
            assert.equal(await readFile(join(first, "migration.json"), "utf8"), before);
            assert.equal((await readMigrationCatalog(A, [second, first])).ok, false);
            assert.equal((await readMigrationCatalog(A, [first, first])).ok, false);
            assert.equal((await readMigrationCatalog(A, [first, join(directory, "missing")])).ok, false);
            assert.deepEqual(value(await readMigrationCatalog(A, [])).migrations, []);
        } finally {await rm(directory, {recursive: true, force: true});}
    });
    it("loads earlier pretty-printed manifests but rejects changed content and malformed JSON", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sd-catalog-format-"));
        try {
            const first = join(directory, "first");
            await save(first, A, B);
            const path = join(first, "migration.json"), manifest = JSON.parse(await readFile(path, "utf8"));
            await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
            assert.equal((await readMigrationCatalog(A, [first])).ok, true);
            manifest.migration.description = "edited";
            await writeFile(path, JSON.stringify(manifest));
            assert.equal((await readMigrationCatalog(A, [first])).ok, false);
            await writeFile(path, "{");
            const invalid = await readMigrationCatalog(A, [first]);
            assert.equal(invalid.ok, false);
            if (!invalid.ok) assert.equal(invalid.problems[0]?.messageKey, "migration.invalidJson");
        } finally {await rm(directory, {recursive: true, force: true});}
    });
});

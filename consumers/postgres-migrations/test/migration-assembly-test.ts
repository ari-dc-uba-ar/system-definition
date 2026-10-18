import {strict as assert} from "node:assert";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes, completeMigrationCatalog, toJsonValue, type ValidationResult} from "system-definition";
import {assembleMigration, type AuthoringRuntime, type CompiledAuthoringInfo} from "../src/authoring";
import {createMigrationDraft} from "../src/migration-draft";
import {saveMigrationArtifact} from "../src/migration-artifact";
import {AuthoringFiles} from "../src/authoring-files";
import {decodeSqlSsot, projectSsotSchema} from "../src/sql-mapping";
import {openArtifactDirectory} from "../src/artifact-files";
import {loadVerifiedMigrationAuthoring} from "../src/migration-plan";
import {computeDraftRevisionHash} from "../src/draft-revision";
import {sha256Hex} from "../src/canonical-hash";
import type {AuthoringBaseInfo} from "../src/authoring-contract";
import type {PgSchemaInfo} from "../src/pg-schema";

function value<T>(result: ValidationResult<T>): T {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;}
const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const snapshot = value(captureSystemSnapshot(context, {systemId: "assembly", entities}));
const system = value(decodeSqlSsot(snapshot, {text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean}));
const desired = value(projectSsotSchema(system, "app"));
const current: PgSchemaInfo = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []};
const base: AuthoringBaseInfo = {from: {systemId: "assembly", releaseId: "empty", releaseHash: "1".repeat(64)}, to: {systemId: "assembly", releaseId: "initial", releaseHash: "2".repeat(64)},
    fromSnapshotHash: "3".repeat(64), toSnapshotHash: "4".repeat(64), fromPersistenceHash: "5".repeat(64), toPersistenceHash: "6".repeat(64)};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Ports = Expect<Equal<Parameters<typeof assembleMigration>[3], Pick<AuthoringRuntime, "readQuery" | "readSql" | "emitResource" | "loadDataContext" | "finalSteps">>>;
type Result = Expect<Equal<Awaited<ReturnType<typeof assembleMigration>>, ValidationResult<CompiledAuthoringInfo>>>;
const contracts: [Ports, Result] = [true, true];
const runtime = (files: AuthoringFiles): Parameters<typeof assembleMigration>[3] => ({emitResource: files.emitResource.bind(files)});

describe("minimal migration assembly and saving", () => {
    it("creates a typed SSOT draft and assembles deterministic SQL without inspection/replay ports", async () => {
        assert.deepEqual(contracts, [true, true]);
        const draft = value(createMigrationDraft("initial", base, current, system, "app"));
        assert.deepEqual(draft.pending, []);
        assert.equal(value(computeDraftRevisionHash(draft)), draft.revisionHash);
        const first = new AuthoringFiles(), second = new AuthoringFiles();
        const assembled = value(await assembleMigration(draft, current, desired, runtime(first)));
        assert.deepEqual(assembled, value(await assembleMigration(draft, current, desired, runtime(second))));
        const texts = assembled.migration.steps.map(step => first.resources.get(step.run.name)!.text);
        assert.match(texts[0], /CREATE TABLE/);
        assert.match(texts[1], /ADD COLUMN/);
        assert.match(texts.at(-1)!, /PRIMARY KEY/);
        assert.deepEqual(draft.decisions, []);
    });
    it("saves canonical authoring once and loads it through existing verified artifact readers", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sd-assembly-"));
        try {
            const files = new AuthoringFiles(), draft = value(createMigrationDraft("initial", base, current, system, "app"));
            const assembled = value(await assembleMigration(draft, current, desired, runtime(files)));
            const target = join(directory, "initial");
            const published = value(await saveMigrationArtifact(target, assembled, files));
            assert.equal(value(completeMigrationCatalog([base.from, base.to], [published])).migrations.length, 1);
            assert.ok(!(await readdir(target)).includes("compiled.json"));
            const reader = value(await openArtifactDirectory(target));
            const verified = value(await loadVerifiedMigrationAuthoring(published, {
                async loadMigrationManifest() {return {ok: true, value: JSON.parse(new TextDecoder().decode(value(await reader.read("migration.json"))))};},
                async readMigrationFile(_migration, file) {return reader.readVerified(file);},
            }));
            assert.deepEqual(value(toJsonValue(verified.authoring)), value(toJsonValue(assembled)));
            await writeFile(join(target, "reviewed.txt"), "keep");
            await assert.rejects(saveMigrationArtifact(target, assembled, files));
            assert.equal(await readFile(join(target, "reviewed.txt"), "utf8"), "keep");
        } finally {await rm(directory, {recursive: true, force: true});}
    });
    it("refuses missing checks and changed SQL bytes before creating the output directory", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sd-assembly-invalid-"));
        try {
            const files = new AuthoringFiles(), draft = value(createMigrationDraft("initial", base, current, system, "app"));
            const assembled = value(await assembleMigration(draft, current, desired, runtime(files)));
            const target = join(directory, "initial");
            const check = {kind: "check" as const, name: "missing", contentHash: "7".repeat(64)};
            assert.equal((await saveMigrationArtifact(target, {...assembled, migration: {...assembled.migration, before: [check]}}, files)).ok, false);
            const step = assembled.migration.steps[0]!;
            files.files.set(`generated/${step.run.contentHash}.sql`, new TextEncoder().encode("SELECT 1"));
            assert.equal((await saveMigrationArtifact(target, assembled, files)).ok, false);
            assert.deepEqual(await readdir(directory), []);
        } finally {await rm(directory, {recursive: true, force: true});}
    });
    it("blocks unresolved decisions and includes declared check bytes when assembling a required field", async () => {
        const table = desired.objects.find(object => object.kind === "table")!;
        const source = {...current, objects: [table]};
        const draft = value(createMigrationDraft("required", base, source, system, "app"));
        assert.ok(draft.pending.length > 0);
        assert.equal((await assembleMigration(draft, source, desired, runtime(new AuthoringFiles()))).ok, false);
        const text = "SELECT NOT EXISTS (SELECT 1 FROM app.items) AS ok;\n";
        const check = {kind: "check" as const, name: "empty-table", contentHash: sha256Hex(new TextEncoder().encode(text))};
        const approved = {...draft, decisions: draft.changes.filter(change => change.impact === "requiresDataCheck").map(change => ({changeId: change.id, source: null, partitionCheck: null, resolution: {kind: "check" as const, run: check}}))};
        const files = new AuthoringFiles();
        const assembled = value(await assembleMigration(approved, source, desired, {...runtime(files), async readSql() {return {ok: true, value: text};}}));
        assert.ok(approved.decisions.length > 1);
        assert.deepEqual(assembled.migration.before, [check]);
        assert.deepEqual(assembled.decisions, approved.decisions);
        assert.equal(files.resources.get(check.name)?.text, text);
    });
    it("deduplicates within a checkpoint while preserving checks at different migration stages", async () => {
        const draft = value(createMigrationDraft("checkpoints", base, desired, system, "app"));
        const checkText = "SELECT true AS ok;\n";
        const first = {kind: "check" as const, name: "first-check.sql", contentHash: sha256Hex(checkText)};
        const second = {...first, name: "second-check.sql"};
        const runText = "SELECT 1;\n";
        const run = (name: string) => ({kind: "sql" as const, name, contentHash: sha256Hex(runText)});
        draft.manual = [
            {id: "first", run: run("first.sql"), dependsOn: [], implementsChanges: [], reads: [], writes: [], destroys: [],
                before: [first, first, second], after: [first, first], rowChecks: []},
            {id: "second", run: run("second.sql"), dependsOn: ["first"], implementsChanges: [], reads: [], writes: [], destroys: [],
                before: [first, second, second], after: [first, first], rowChecks: []},
        ];
        draft.revisionHash = value(computeDraftRevisionHash(draft));
        const files = new AuthoringFiles();
        const assembled = value(await assembleMigration(draft, desired, desired, {...runtime(files),
            async readSql(ref) {return {ok: true, value: ref.kind === "check" ? checkText : runText};},
        }));
        assert.deepEqual(assembled.migration.before, [first, second]);
        assert.deepEqual(assembled.checkpoints.map(({afterStep, checks}) => ({afterStep, checks})), [
            {afterStep: "first", checks: [first, second]},
            {afterStep: "second", checks: [first]},
        ]);
        assert.deepEqual(draft.manual[0]?.before, [first, first, second]);
    });
});

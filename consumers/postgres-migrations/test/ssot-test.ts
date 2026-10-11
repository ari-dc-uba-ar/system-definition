import {strict as assert} from "node:assert";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes,
    defineRecord, withRecords, defineEntity, defineEntities, type SystemSnapshotInfo, type ValidationResult} from "system-definition";
import {loadSsot} from "../src/ssot";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type LoaderContract = Expect<Equal<typeof loadSsot, (file: string) => Promise<ValidationResult<SystemSnapshotInfo>>>>;
const contract: LoaderContract = true;

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}, enabled: {type: "boolean"}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const captured = captureSystemSnapshot(context, {systemId: "items", entities, records: context.records});
if (!captured.ok) throw new Error(JSON.stringify(captured.problems));
const snapshot = captured.value;

async function fixture(source: string, body: (file: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "sd-ssot-loader-"));
    try {
        const file = join(root, "system.mjs");
        await writeFile(file, source);
        await body(file);
    } finally { await rm(root, {recursive: true, force: true}); }
}

describe("SSOT loading", () => {
    it("loads the model produced by system-definition", () => fixture(`export const ssot = ${JSON.stringify(snapshot)};`, async file => {
        assert.equal(contract, true);
        const loaded = await loadSsot(file);
        assert.deepEqual(loaded, {ok: true, value: snapshot});
    }));
    it("uses the core decoder to reject malformed entities", () => fixture(`export const ssot = ${JSON.stringify({...snapshot, entities: {items: {...snapshot.entities.items, pk: ["missing"]}}})};`, async file => {
        assert.equal((await loadSsot(file)).ok, false);
    }));
    it("rejects modules without an exported SSOT", () => fixture("export const other = {};", async file => {
        assert.equal((await loadSsot(file)).ok, false);
    }));
});

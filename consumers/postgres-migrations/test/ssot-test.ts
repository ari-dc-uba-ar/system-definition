import {strict as assert} from "node:assert";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes,
    defineRecord, withRecords, defineEntity, defineEntities, sqlTypes, type SqlTypeMapping, type ValidationResult} from "system-definition";
import {loadSsot} from "../src/ssot";
import {decodeSqlSsot, type SqlSsotInfo} from "../src/sql-mapping";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type LoaderContract = Expect<Equal<typeof loadSsot, (file: string) => Promise<ValidationResult<SqlSsotInfo>>>>;
const contract: LoaderContract = true;

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}, enabled: {type: "boolean"}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const captured = captureSystemSnapshot(context, {systemId: "items", entities, records: context.records});
if (!captured.ok) throw new Error(JSON.stringify(captured.problems));
const snapshot = captured.value;
const sqlMapping = {text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean} satisfies SqlTypeMapping<typeof snapshot>;

async function fixture(source: string, body: (file: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "sd-ssot-loader-"));
    try {
        const file = join(root, "system.mjs");
        await writeFile(file, source);
        await body(file);
    } finally { await rm(root, {recursive: true, force: true}); }
}

describe("SSOT loading", () => {
    it("loads the model and required SQL mapping produced by the backend", () => fixture(`export const ssot = ${JSON.stringify(snapshot)}; export const sqlMapping = ${JSON.stringify(sqlMapping)};`, async file => {
        assert.equal(contract, true);
        const loaded = await loadSsot(file);
        assert.deepEqual(loaded, decodeSqlSsot(snapshot, sqlMapping));
    }));
    it("uses the core decoder to reject malformed entities", () => fixture(`export const ssot = ${JSON.stringify({...snapshot, entities: {items: {...snapshot.entities.items, pk: ["missing"]}}})};`, async file => {
        assert.equal((await loadSsot(file)).ok, false);
    }));
    it("rejects modules without an exported SSOT", () => fixture("export const other = {};", async file => {
        assert.equal((await loadSsot(file)).ok, false);
    }));
    it("rejects a valid SSOT without its SQL mapping", () => fixture(`export const ssot = ${JSON.stringify(snapshot)};`, async file => {
        assert.equal((await loadSsot(file)).ok, false);
    }));
    it("rejects missing, extra and unsupported SQL mappings at loading time", async () => {
        for (const mapping of [{integer: sqlTypes.integer}, {...sqlMapping, extra: sqlTypes.text}, {...sqlMapping, text: "guessed_type"}]) {
            await fixture(`export const ssot = ${JSON.stringify(snapshot)}; export const sqlMapping = ${JSON.stringify(mapping)};`, async file => {
                assert.equal((await loadSsot(file)).ok, false);
            });
        }
    });
});

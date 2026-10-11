import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes, defineRecord, withRecords, defineEntity, defineEntities, type CoreFieldDef} from "system-definition";
import {definePostgresSystem} from "../src/ssot-definition";

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours,
    completeField: (field: CoreFieldDef<typeof commonTypeDefs>, name: string) => completeCoreField(field, name)});
const item = defineRecord(types, {id: {type: "integer"}, enabled: {type: "boolean"}});
const context = withRecords(types, {item});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const ssot = definePostgresSystem(context, {systemId: "items", entities});
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type PreservedContext = Expect<Equal<typeof ssot.context, typeof context>>;
type PreservedEntity = Expect<Equal<typeof ssot.definition.entities.items, typeof entities.items>>;
const checks: [PreservedContext, PreservedEntity] = [true, true];

describe("SSOT-only PostgreSQL definition", () => {
    it("preserves literals and separates the serializable definition from behaviours", () => {
        assert.deepEqual(checks, [true, true]);
        assert.equal(ssot.context, context);
        assert.equal(ssot.definition.entities, entities);
        assert.equal(JSON.parse(JSON.stringify(ssot.definition)).systemId, "items");
    });
});

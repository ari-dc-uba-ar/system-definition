import {
    captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField,
    defineTypes, defineRecord, withRecords, defineEntity, defineEntities, sqlTypes,
} from "system-definition";
import type {PostgresStorageDef} from "../../src/postgres-storage";

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {
    parent: defineRecord(types, {id: {type: "integer", nullable: false}}),
    item: defineRecord(types, {id: {type: "integer", nullable: false}, parentId: {type: "integer", nullable: false}, slug: {type: "text", nullable: false}}),
});
const entities = defineEntities({
    parents: defineEntity(context, {name: "parents", record: "parent", pk: ["id"], fks: {}, uks: {}, validators: []}),
    items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {parent: {entity: "parents", fields: {parentId: "id"}}}, uks: {slug: ["slug"]}, validators: []}),
});
const captured = captureSystemSnapshot(context, {systemId: "key-storage", entities, records: context.records});
if (!captured.ok) throw new Error(JSON.stringify(captured.problems));
export const snapshot = captured.value;
export const mapping = {text: sqlTypes.text, integer: sqlTypes.bigint, boolean: sqlTypes.boolean};
export const storage = (initiallyDeferred: boolean) => ({entities: {items: {
    foreignKeys: {parent: {name: "legacy_parent_fk", deferrable: true, initiallyDeferred}},
    uniqueKeys: {slug: {name: "legacy_slug_key", deferrable: true, initiallyDeferred: false}},
}}} satisfies PostgresStorageDef<typeof snapshot>);

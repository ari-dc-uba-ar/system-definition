import {strict as assert} from "node:assert";
import {isInspectionControlSql} from "./fixtures/inspection-control-fixture";
import {describe, it} from "mocha";
import {captureSystemSnapshot, commonTypeDefs, commonTypeBehaviours, completeCoreField, defineTypes,
    defineRecord, withRecords, defineEntity, defineEntities, sqlTypes} from "system-definition";
import {assessSchema} from "../src/assessment";
import {decodeSqlSsot, projectSsotSchema} from "../src/sql-mapping";
import type {PgSession} from "../src/pg-schema";

const types = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const context = withRecords(types, {item: defineRecord(types, {id: {type: "integer"}, name: {type: "text"}})});
const entities = defineEntities({items: defineEntity(context, {name: "items", record: "item", pk: ["id"], fks: {}, uks: {}, validators: []})});
const captured = captureSystemSnapshot(context, {systemId: "items", entities, records: context.records});
if (!captured.ok) throw new Error(JSON.stringify(captured.problems));
const mapped = decodeSqlSsot(captured.value, {text: sqlTypes.text, integer: sqlTypes.integer, boolean: sqlTypes.boolean});
if (!mapped.ok) throw new Error(JSON.stringify(mapped.problems));
const ssot = mapped.value;

describe("read-only schema assessment", () => {
    it("projects the SSOT without release, journal or resource configuration", () => {
        const result = projectSsotSchema(ssot, "app");
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(result.value.schemas, ["app"]);
            assert.equal(result.value.objects.filter(object => object.kind === "table").length, 1);
            assert.equal(result.value.objects.find(object => object.kind === "column" && object.identity.name === "id")?.kind, "column");
        }
    });
    it("reports missing database objects as additions toward the SSOT", async () => {
        const queries: string[] = [];
        const session: PgSession = {async query(sql) {
            queries.push(sql);
            if (isInspectionControlSql(sql)) return {rows: [], rowCount: null};
            assert.match(sql, /^\s*(WITH|SELECT|SHOW)\b/);
            return {rows: [], rowCount: 0};
        }, async close() {throw new Error("Caller owns this session");}};
        const result = await assessSchema(ssot, "app", session);
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(result.value.equal, false);
            assert.ok(result.value.differences.some(difference => difference.change === "add" && difference.path.includes("items")));
            assert.ok(result.value.differences.every(difference => difference.impact === "preserving"));
        }
        assert.equal(queries.filter(sql => !isInspectionControlSql(sql)).length, 1);
    });
});

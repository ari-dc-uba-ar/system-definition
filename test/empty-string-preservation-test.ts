import * as assert from "node:assert/strict";
import {commonTypeDefs, completeCoreField, defineTypes} from "../src/common/ssot-types";
import {commonTypeBehaviours} from "../src/common/type-behaviour";
import {defineRecord} from "../src/common/ssot-record";
import {deserializeRecord, deserializeProblems, serializeFields, type ParseOptions, type TextRecord} from "../src/common/serialize";
import {parseRecord} from "../src/common/human";

const context = defineTypes({types: commonTypeDefs, behaviours: commonTypeBehaviours, completeField: completeCoreField});
const fields = defineRecord(context, {
    requiredText: {type: "text", nullable: false},
    optionalText: {type: "text"},
    count: {type: "integer"},
});
const preserveEmpty = {requireMandatory: true, emptyStringIsNull: false} satisfies ParseOptions;

describe("optional empty-string preservation for machine records", function () {
    it("round-trips valid empty text rather than converting it to null", function () {
        const original = {requiredText: "", optionalText: "", count: null};
        const encoded = serializeFields(context, fields, original);
        const decoded = deserializeRecord(context, fields, encoded, preserveEmpty);
        assert.ok(decoded.ok);
        assert.deepEqual(decoded.value, original);
    });

    it("keeps nullable empty text distinct from explicit SQL null", function () {
        const empty = deserializeRecord(context, fields, {requiredText: "present", optionalText: "", count: null}, preserveEmpty);
        const nil = deserializeRecord(context, fields, {requiredText: "present", optionalText: null, count: null}, preserveEmpty);
        assert.ok(empty.ok && nil.ok);
        assert.equal(empty.value.optionalText, "");
        assert.equal(nil.value.optionalText, null);
    });

    it("lets non-text behaviors reject empty input instead of accepting null", function () {
        const decoded = deserializeRecord(context, fields, {requiredText: "present", optionalText: null, count: ""}, preserveEmpty);
        assert.equal(decoded.ok, false);
        if (decoded.ok) return;
        assert.equal(decoded.problems[0].field, "count");
        assert.equal(decoded.problems[0].messageKey, "type.integer");
    });

    it("keeps default machine and human blank handling unchanged", function () {
        const source = {requiredText: "present", optionalText: "", count: null};
        for (const result of [deserializeRecord(context, fields, source), parseRecord(context, fields, source, "es-AR")]) {
            assert.ok(result.ok);
            assert.equal(result.value.optionalText, null);
        }
    });

    it("still reports missing or explicitly null required values in preservation mode", function () {
        const inputs: readonly TextRecord[] = [{optionalText: "", count: null}, {requiredText: null, optionalText: "", count: null}];
        for (const input of inputs) {
            const problems = deserializeProblems(context, fields, input, preserveEmpty);
            assert.equal(problems.length, 1);
            assert.equal(problems[0].field, "requiredText");
            assert.equal(problems[0].messageKey, "field.required");
        }
        assert.deepEqual(deserializeProblems(context, fields, {requiredText: "", optionalText: "", count: null}, preserveEmpty), []);
    });
});

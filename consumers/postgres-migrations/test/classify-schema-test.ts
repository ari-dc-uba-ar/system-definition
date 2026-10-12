import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {classifySchemaDifferences, type SchemaClassificationInfo} from "../src/classify-schema";
import {compareSchemas, type SchemaComparisonInfo, type SchemaDifferenceInfo} from "../src/compare-schema";
import type {ChangeImpact} from "../src/authoring-contract";
import type {PgObjectInfo, PgSchemaInfo} from "../src/pg-schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type ResultContract = Expect<Equal<SchemaClassificationInfo, {equal: boolean; differences: readonly (SchemaDifferenceInfo & {impact: ChangeImpact})[]}>>;
type FunctionContract = Expect<Equal<typeof classifySchemaDifferences, (comparison: SchemaComparisonInfo) => SchemaClassificationInfo>>;
const contracts: [ResultContract, FunctionContract] = [true, true];

const people: PgObjectInfo = {kind: "table", identity: {schema: "app", kind: "table", name: "people", parentName: null, signature: []}, persistence: "permanent", relationKind: "r"};
const name = {
    kind: "column", identity: {schema: "app", kind: "column", name: "name", parentName: "people", signature: []},
    type: {schema: "pg_catalog", name: "text", modifiers: [], arrayDimensions: 0, collation: null},
    nullable: true, defaultExpression: null, identityDefinition: null, generatedDefinition: null,
} satisfies PgObjectInfo;
const schema = (objects: readonly PgObjectInfo[]): PgSchemaInfo => ({formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects});
function classify(before: readonly PgObjectInfo[], after: readonly PgObjectInfo[]) {
    const compared = compareSchemas(schema(before), {schema: schema(after), unknown: [], excluded: []});
    if (!compared.ok) throw new Error(JSON.stringify(compared.problems));
    const original = JSON.stringify(compared.value);
    const result = classifySchemaDifferences(compared.value);
    assert.equal(JSON.stringify(compared.value), original, "classification must not mutate its input");
    return result;
}

describe("pure migration difference classification", () => {
    it("marks view additions and edits unsupported rather than automatically preserving", () => {
        const view: PgObjectInfo = {kind: "view", identity: {schema: "app", kind: "view", name: "v", parentName: null, signature: []}, definition: "SELECT 1", columns: ["n"], options: {}};
        assert.equal(classify([], [view]).differences[0]?.impact, "unsupported");
        assert.equal(classify([view], [{...view, definition: "SELECT 2"}]).differences[0]?.impact, "unsupported");
    });
    it("reuses comparison and impact contracts without release/history inputs", () => {
        assert.deepEqual(contracts, [true, true]);
        assert.deepEqual(classify([people, name], [people, name]), {equal: true, differences: []});
    });
    it("distinguishes nullable additions from additions requiring existing-row values", () => {
        assert.equal(classify([people], [people, name]).differences[0]?.impact, "preserving");
        assert.equal(classify([people], [people, {...name, nullable: false}]).differences[0]?.impact, "requiresDataCheck");
        assert.ok(classify([], [people, {...name, nullable: false}]).differences.every(diff => diff.impact === "preserving"));
    });
    it("groups table drops and their children into one destructive data decision", () => {
        const result = classify([people, name], []);
        assert.equal(result.differences.length, 1);
        assert.equal(result.differences[0]?.path[2], "table");
        assert.equal(result.differences[0]?.impact, "destructive");
        assert.equal(classify([people, name], [people]).differences[0]?.impact, "destructive");
    });
    it("leaves an apparent rename as a removal and addition for an explicit user decision", () => {
        const result = classify([people, name], [people, {...name, identity: {...name.identity, name: "display_name"}}]);
        assert.equal(result.differences.length, 2);
        assert.equal(result.differences.find(diff => diff.change === "remove")?.impact, "destructive");
        assert.equal(result.differences.find(diff => diff.change === "add")?.impact, "preserving");
    });
    it("marks stricter nullability and type changes for data checks, and default changes as preserving", () => {
        assert.equal(classify([people, name], [people, {...name, nullable: false}]).differences[0]?.impact, "requiresDataCheck");
        assert.equal(classify([people, {...name, nullable: false}], [people, name]).differences[0]?.impact, "preserving");
        assert.equal(classify([people, name], [people, {...name, type: {...name.type, name: "int4"}}]).differences[0]?.impact, "requiresDataCheck");
        assert.equal(classify([people, name], [people, {...name, defaultExpression: "'unknown'"}]).differences[0]?.impact, "preserving");
        assert.equal(classify([people, name], [people, {...name, generatedDefinition: "s"}]).differences[0]?.impact, "unsupported");
    });
    it("requires data checks for added constraints", () => {
        const unique: PgObjectInfo = {
            kind: "constraint", identity: {schema: "app", kind: "constraint", name: "people_name_key", parentName: "people", signature: []},
            constraintKind: "unique", definition: "UNIQUE (name)", columns: ["name"], target: null, pairs: [],
            deferrable: false, initiallyDeferred: false, validated: true, enforced: true,
        };
        assert.equal(classify([people, name], [people, name, unique]).differences[0]?.impact, "requiresDataCheck");
        assert.equal(classify([people, name, unique], [people, name]).differences[0]?.impact, "preserving");
    });
});

import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {problem, type StructuralFailure, type ValidationResult} from "system-definition";
import {assessMigrationDecisions} from "../src/migration-decisions";
import {decodeDataDecisionInfo, decodeDestructiveDecisionInfo, type DataDecisionInfo, type MigrationDraftInfo, type PendingQuestionInfo, type StructureChangeInfo} from "../src/authoring-contract";
import type {DataMigrationInfo} from "../src/migration-authoring";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Contract = Expect<Equal<typeof assessMigrationDecisions, (changes: readonly StructureChangeInfo[], draft: Pick<MigrationDraftInfo, "decisions" | "data" | "manual">) => ValidationResult<readonly PendingQuestionInfo[]>>>;
const contract: Contract = true;
type DecoderContract = Expect<Equal<typeof decodeDataDecisionInfo, (value: unknown, path: string, invalid: StructuralFailure) => ValidationResult<DataDecisionInfo>>>;
const decoderContract: DecoderContract = true;
const column = (name: string) => ({schema: "app", kind: "column", name, parentName: "people", signature: []});
const required = (id: string, name: string): StructureChangeInfo => ({id, action: "add", origin: "inferred", impact: "requiresDataCheck",
    before: null, after: column(name), differences: [], affectedFields: [{side: "to", entity: "people", field: name}], dependsOn: []});
const code = required("migration-A:code", "code"), name = required("migration-A:name", "name");
const fill: DataMigrationInfo = {
    id: "fill-code", description: "fill required codes", dependsOn: [], arguments: {}, transformation: "create-code",
    source: {query: {kind: "query", name: "source", contentHash: "1".repeat(64)}, ports: {}, identity: [], coverageChecks: []},
    writes: [{kind: "update", entity: "people", values: [{output: "code", target: {side: "to", entity: "people", field: "code"}}], match: [], whenMissing: "error"}], conservationChecks: [],
};
const choice: DataDecisionInfo = {changeId: code.id, source: null, partitionCheck: null,
    resolution: {kind: "migrate", dataMigrationId: fill.id, outputs: ["code"]}};
const input = (decisions: readonly DataDecisionInfo[] = [], data: readonly DataMigrationInfo[] = []) => ({decisions, data, manual: []});
function pending(result: ValidationResult<readonly PendingQuestionInfo[]>) {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}

describe("migration decision readiness", () => {
    it("derives every unresolved change without a pending flag or database/runtime", () => {
        assert.equal(contract, true);
        assert.deepEqual(pending(assessMigrationDecisions([code, name], input())).map(question => question.id), [code.id, name.id]);
        assert.deepEqual(pending(assessMigrationDecisions([], input())), []);
    });
    it("does not let unrelated data or even a matching write substitute for an explicit decision", () => {
        assert.equal(pending(assessMigrationDecisions([code], input([], [fill]))).length, 1);
        assert.deepEqual(pending(assessMigrationDecisions([code, name], input([choice], [fill]))).map(question => question.id), [name.id]);
        assert.deepEqual(pending(assessMigrationDecisions([code], input([choice], [fill]))), []);
    });
    it("rejects stale decisions, duplicate decisions, missing transformations and wrong destinations", () => {
        assert.equal(assessMigrationDecisions([code], input([{...choice, changeId: "migration-B:code"}], [fill])).ok, false);
        assert.equal(assessMigrationDecisions([code], input([choice, choice], [fill])).ok, false);
        assert.equal(assessMigrationDecisions([code], input([choice])).ok, false);
        const unrelated = {...fill, writes: [{...fill.writes[0]!, values: [{output: "code", target: {side: "to" as const, entity: "people", field: "name"}}]}]};
        assert.equal(assessMigrationDecisions([code], input([choice], [unrelated])).ok, false);
        const wrongEntity = {...fill, writes: [{...fill.writes[0]!, entity: "other"}]};
        assert.equal(assessMigrationDecisions([code], input([choice], [wrongEntity])).ok, false);
    });
    it("accepts explicit data checks and forbids using a check or discard to authorize data loss", () => {
        const check: DataDecisionInfo = {...choice, resolution: {kind: "check", run: {kind: "check", name: "empty-table", contentHash: "2".repeat(64)}}};
        assert.deepEqual(pending(assessMigrationDecisions([code], input([check]))), []);
        const drop: StructureChangeInfo = {...code, action: "remove", impact: "destructive", before: code.after, after: null,
            affectedFields: [{side: "from", entity: "people", field: "code"}]};
        assert.equal(assessMigrationDecisions([drop], input([check])).ok, false);
        assert.equal(assessMigrationDecisions([code], input([{...choice, resolution: {kind: "discard", reason: "remove it"}}])).ok, false);
    });
    it("requires consumption of a supplied transformation source", () => {
        const source = {side: "from" as const, entity: "people", field: "legacy"};
        assert.equal(assessMigrationDecisions([code], input([{...choice, source}], [fill])).ok, false);
    });
    it("decodes exact check decisions without widening destructive approval", () => {
        assert.equal(decoderContract, true);
        const invalid: StructuralFailure = (_path, reason) => ({ok: false, problems: [problem(null, "migration.authoringInvalid", "blocking", {reason})]});
        const check: DataDecisionInfo = {...choice, resolution: {kind: "check", run: {kind: "check", name: "verify-code", contentHash: "2".repeat(64)}}};
        assert.deepEqual(decodeDataDecisionInfo(check, "decision", invalid), {ok: true, value: check});
        assert.equal(decodeDataDecisionInfo({...check, approved: true}, "decision", invalid).ok, false);
        assert.equal(decodeDataDecisionInfo({...check, resolution: {kind: "check", run: {kind: "sql", name: "mutate", contentHash: "2".repeat(64)}}}, "decision", invalid).ok, false);
        assert.equal(decodeDestructiveDecisionInfo(check, "decision", invalid).ok, false);
    });
    it("exempts children of an empty new table and recognizes explicit manual resolutions", () => {
        const table: StructureChangeInfo = {...code, id: "new-table", impact: "preserving", after: {schema: "app", kind: "table", name: "people", parentName: null, signature: []}};
        assert.deepEqual(pending(assessMigrationDecisions([table, code], input())), []);
        const manual: MigrationDraftInfo["manual"] = [{id: "fill-and-add-code", run: {kind: "sql", name: "manual", contentHash: "3".repeat(64)},
            implementsChanges: [code.id], reads: [], writes: [code.after!], destroys: [], dependsOn: [], before: [], after: [], rowChecks: []}];
        assert.deepEqual(pending(assessMigrationDecisions([code], {...input(), manual})), []);
    });
});

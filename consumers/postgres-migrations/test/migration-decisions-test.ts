import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {problem, type StructuralFailure, type ValidationResult} from "system-definition";
import {assessMigrationDecisions, collectMigrationDecisions, validateMigrationDecisions} from "../src/migration-decisions";
import {computeDraftRevisionHash} from "../src/draft-revision";
import {decodeDataDecisionInfo, decodeDestructiveDecisionInfo, type DataDecisionInfo, type MigrationDraftInfo, type PendingQuestionInfo, type StructureChangeInfo} from "../src/authoring-contract";
import type {DataMigrationInfo} from "../src/migration-authoring";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Contract = Expect<Equal<typeof assessMigrationDecisions, (changes: readonly StructureChangeInfo[], draft: Pick<MigrationDraftInfo, "decisions" | "data" | "manual">) => ValidationResult<readonly PendingQuestionInfo[]>>>;
const contract: Contract = true;
type DecoderContract = Expect<Equal<typeof decodeDataDecisionInfo, (value: unknown, path: string, invalid: StructuralFailure) => ValidationResult<DataDecisionInfo>>>;
const decoderContract: DecoderContract = true;
type CollectorContract = Expect<Equal<typeof collectMigrationDecisions, (draft: MigrationDraftInfo, input: unknown) => ValidationResult<MigrationDraftInfo>>>;
const collectorContract: CollectorContract = true;
type GateContract = Expect<Equal<typeof validateMigrationDecisions, (changes: readonly StructureChangeInfo[], draft: Pick<MigrationDraftInfo, "decisions" | "data" | "manual">) => ValidationResult<true>>>;
const gateContract: GateContract = true;
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

function value<T>(result: ValidationResult<T>): T {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;}
function draft(): MigrationDraftInfo {
    const release = (id: string, hash: string) => ({systemId: "people", releaseId: id, releaseHash: hash.repeat(64)});
    const result: MigrationDraftInfo = {formatVersion: 1, id: "required-code-and-name", revisionHash: "",
        base: {from: release("before", "1"), to: release("after", "2"), fromSnapshotHash: "3".repeat(64), toSnapshotHash: "4".repeat(64), fromPersistenceHash: "5".repeat(64), toPersistenceHash: "6".repeat(64)},
        renames: [], changes: [code, name], data: [fill], decisions: [], manual: [], pending: []};
    return {...result, revisionHash: value(computeDraftRevisionHash(result))};
}

describe("migration decision collection", () => {
    it("collects partial answers without mutating the draft or trusting stored pending flags", () => {
        assert.equal(collectorContract, true);
        const current = draft(), original = structuredClone(current);
        const result = value(collectMigrationDecisions(current, {id: current.id, revisionHash: current.revisionHash, decisions: [choice]}));
        assert.deepEqual(result.decisions, [choice]);
        assert.deepEqual(result.pending.map(question => question.id), [name.id]);
        assert.notEqual(result.revisionHash, current.revisionHash);
        assert.deepEqual(current, original);
        const remaining: DataDecisionInfo = {...choice, changeId: name.id, resolution: {kind: "check", run: {kind: "check", name: "name-is-valid", contentHash: "7".repeat(64)}}};
        const complete = value(collectMigrationDecisions(result, {id: result.id, revisionHash: result.revisionHash, decisions: [remaining]}));
        assert.deepEqual(complete.decisions, [choice, remaining]);
        assert.deepEqual(complete.pending, []);
    });
    it("rejects answers for another migration, outdated revisions and malformed choices", () => {
        const current = draft(), answers = {id: current.id, revisionHash: current.revisionHash, decisions: [choice]};
        const changed = value(collectMigrationDecisions(current, answers));
        for (const input of [{...answers, id: "another-migration"}, {...answers, revisionHash: "0".repeat(64)}, {...answers, extra: true}, {...answers, decisions: [{...choice, approved: true}]}]) {
            assert.equal(collectMigrationDecisions(current, input).ok, false);
        }
        assert.equal(collectMigrationDecisions(changed, answers).ok, false);
        assert.equal(collectMigrationDecisions({...current, data: []}, answers).ok, false);
    });
    it("delegates duplicate, unrelated and missing transformation validation", () => {
        const current = draft(), answers = {id: current.id, revisionHash: current.revisionHash, decisions: [choice]};
        assert.equal(collectMigrationDecisions(current, {...answers, decisions: [choice, choice]}).ok, false);
        assert.equal(collectMigrationDecisions(current, {...answers, decisions: [{...choice, changeId: "other-change"}]}).ok, false);
        assert.equal(collectMigrationDecisions(current, {...answers, decisions: [{...choice, resolution: {kind: "migrate", dataMigrationId: "missing", outputs: ["code"]}}]}).ok, false);
    });
    it("persists direct CLI decisions without a project/report and preserves the draft on failure", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sd-decisions-"));
        try {
            const current = draft(), draftPath = join(directory, "draft.json"), answersPath = join(directory, "answers.json");
            await writeFile(draftPath, JSON.stringify(current));
            await writeFile(answersPath, JSON.stringify({id: current.id, revisionHash: current.revisionHash, decisions: [choice]}));
            const run = () => spawnSync(process.execPath, [resolve(__dirname, "../src/cli-main.js"), "resolve", "--draft", draftPath, "--answers", answersPath, "--non-interactive"], {encoding: "utf8", timeout: 10000, env: {...process.env, CI: "true"}});
            const collected = run();
            assert.equal(collected.status, 0, collected.stdout + collected.stderr);
            const saved = await readFile(draftPath, "utf8");
            assert.deepEqual(JSON.parse(saved).decisions, [choice]);
            assert.deepEqual(JSON.parse(saved).pending.map((question: PendingQuestionInfo) => question.id), [name.id]);
            const stale = run();
            assert.notEqual(stale.status, 0);
            assert.equal(JSON.parse(stale.stdout).ok, false);
            assert.equal(await readFile(draftPath, "utf8"), saved);
        } finally {await rm(directory, {recursive: true, force: true});}
    });
});

describe("migration decision readiness", () => {
    it("gates generation on supplied differences regardless of stored changes or pending flags", () => {
        assert.equal(gateContract, true);
        const current = {...draft(), changes: [], pending: [], decisions: [choice]};
        const unresolved = validateMigrationDecisions([code, name], current);
        assert.equal(unresolved.ok, false);
        if (!unresolved.ok) assert.equal(unresolved.problems[0]?.messageKey, "migration.authoringPending");
        const check: DataDecisionInfo = {...choice, changeId: name.id, resolution: {kind: "check", run: {kind: "check", name: "name-valid", contentHash: "7".repeat(64)}}};
        assert.deepEqual(validateMigrationDecisions([code, name], {...current, decisions: [choice, check]}), {ok: true, value: true});
        assert.equal(validateMigrationDecisions([{...code, id: "updated-change"}], current).ok, false);
        const unsupported = validateMigrationDecisions([{...code, impact: "unsupported"}], input());
        assert.equal(unsupported.ok, false);
        if (!unsupported.ok) assert.equal(unsupported.problems[0]?.messageKey, "migration.unsupportedSchemaFeature");
    });
    it("rejects manual claims with unrelated effects, duplicate coverage or non-SQL resources", () => {
        const step: MigrationDraftInfo["manual"][number] = {id: "manual-code", run: {kind: "sql", name: "fill-code", contentHash: "3".repeat(64)},
            implementsChanges: [code.id], reads: [], writes: [code.after!], destroys: [], dependsOn: [], before: [], after: [], rowChecks: []};
        assert.deepEqual(validateMigrationDecisions([code], {...input(), manual: [step]}), {ok: true, value: true});
        for (const changes of [[code], [{...code, action: "alter" as const, before: code.after}]]) {
            assert.equal(validateMigrationDecisions(changes, {...input(), manual: [{...step, writes: [name.after!]}]}).ok, false);
        }
        assert.equal(validateMigrationDecisions([code], {...input(), manual: [step, {...step, id: "another-step"}]}).ok, false);
        assert.equal(validateMigrationDecisions([code], {...input(), manual: [{...step, run: {...step.run, kind: "check"}}]}).ok, false);
    });
    it("requires explicit data decisions even when manual SQL declares a destructive effect", () => {
        const drop: StructureChangeInfo = {...code, action: "remove", impact: "destructive", before: code.after, after: null,
            affectedFields: [{side: "from", entity: "people", field: "code"}]};
        const manual: MigrationDraftInfo["manual"] = [{id: "drop-code", run: {kind: "sql", name: "drop-code", contentHash: "3".repeat(64)},
            implementsChanges: [drop.id], reads: [], writes: [], destroys: [drop.before!], dependsOn: [], before: [], after: [], rowChecks: []}];
        assert.equal(validateMigrationDecisions([drop], {...input(), manual}).ok, false);
        const decision: DataDecisionInfo = {changeId: drop.id, source: drop.affectedFields[0]!, partitionCheck: null, resolution: {kind: "discard", reason: "Obsolete data"}};
        assert.deepEqual(validateMigrationDecisions([drop], {...input([decision]), manual}), {ok: true, value: true});
    });
    it("requires a type transformation to consume the column being converted", () => {
        const changed: StructureChangeInfo = {...code, action: "alter", before: code.after, differences: [{path: ["type", "name"], before: "text", after: "int4"}]};
        assert.equal(validateMigrationDecisions([changed], input([choice], [fill])).ok, false);
        const source = {side: "from" as const, entity: "people", field: "code"};
        const conversion: DataMigrationInfo = {...fill, source: {...fill.source, ports: {code: {field: source, domain: {side: "from", type: "text", nullable: true}}}}};
        assert.deepEqual(validateMigrationDecisions([changed], input([{...choice, source}], [conversion])), {ok: true, value: true});
    });
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

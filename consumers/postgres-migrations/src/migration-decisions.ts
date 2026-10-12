import {exactKeys, isPlainObject, problem, toJsonValue, type ValidationResult} from "system-definition";
import {decodeDataDecisionInfo, type DataDecisionInfo, type FieldRefInfo, type MigrationDraftInfo, type PendingQuestionInfo, type StructureChangeInfo} from "./authoring-contract";
import type {DataMigrationInfo} from "./migration-authoring";
import {computeDraftRevisionHash} from "./draft-revision";
import {samePgIdentity} from "./pg-identity";

/** Collect choices for one draft revision; callers persist the returned draft. */
export function collectMigrationDecisions(draft: MigrationDraftInfo, input: unknown): ValidationResult<MigrationDraftInfo> {
    const invalid = (reason: string) => fail(reason, draft.id);
    const copied = toJsonValue(input);
    if (!copied.ok) return copied;
    const answers = copied.value;
    if (!isPlainObject(answers)) return invalid("Expected migration decisions");
    const shape = exactKeys(answers, ["id", "revisionHash", "decisions"], "$", (_path, reason) => invalid(reason));
    if (!shape.ok) return shape;
    if (answers.id !== draft.id || answers.revisionHash !== draft.revisionHash) return invalid("Decisions belong to another migration or draft revision");
    const current = computeDraftRevisionHash(draft);
    if (!current.ok) return current;
    if (current.value !== draft.revisionHash) return invalid("Draft revision is stale");
    if (!Array.isArray(answers.decisions)) return invalid("Expected a decision array");
    const decisions = [...draft.decisions];
    for (const [index, raw] of answers.decisions.entries()) {
        const decoded = decodeDataDecisionInfo(raw, `decisions[${index}]`, (_path, reason) => invalid(reason));
        if (!decoded.ok) return decoded;
        decisions.push(decoded.value);
    }
    const next = {...draft, decisions};
    const pending = assessMigrationDecisions(draft.changes, next);
    if (!pending.ok) return pending;
    const revision = computeDraftRevisionHash(next);
    return revision.ok ? {ok: true, value: {...next, pending: pending.value, revisionHash: revision.value}} : revision;
}

function fail(reason: string, changeId: string, key = "migration.authoringInvalid"): ValidationResult<never> {
    return {ok: false, problems: [problem(null, key, "blocking", {changeId, reason})]};
}
const sameField = (left: FieldRefInfo, right: FieldRefInfo) => left.side === right.side && left.entity === right.entity && left.field === right.field;
const decisionKey = (changeId: string, source: FieldRefInfo | null) => JSON.stringify([changeId, source?.side, source?.entity, source?.field]);

function validateResolution(change: StructureChangeInfo, decision: DataDecisionInfo, data: readonly DataMigrationInfo[]): ValidationResult<true> {
    const resolution = decision.resolution;
    if (resolution.kind === "discard") {
        return change.impact === "destructive" && resolution.reason.trim().length > 0
            ? {ok: true, value: true} : fail("Discard requires a destructive change and a non-empty reason", change.id);
    }
    if (resolution.kind === "check") {
        return change.impact === "requiresDataCheck" && resolution.run.kind === "check"
            ? {ok: true, value: true} : fail("A check cannot authorize data loss", change.id);
    }
    const matches = data.filter(migration => migration.id === resolution.dataMigrationId);
    const migration = matches[0];
    if (matches.length !== 1 || migration === undefined) return fail("Decision must reference exactly one data migration", change.id, "migration.invalidReference");
    if (decision.source !== null && !Object.values(migration.source.ports).some(port => port.field !== null && sameField(port.field, decision.source!))) {
        return fail("Data migration does not consume the decision's source", change.id, "migration.invalidReference");
    }
    if (change.impact === "destructive" && decision.source === null) return fail("Preserving removed data requires a source field", change.id, "migration.invalidReference");
    if (resolution.outputs.length === 0 || new Set(resolution.outputs).size !== resolution.outputs.length || resolution.outputs.some(output => output.length === 0)) {
        return fail("Migrate outputs must be non-empty and unique", change.id);
    }
    const writes = migration.writes.flatMap(write => write.values.filter(binding => resolution.outputs.includes(binding.output)
        && binding.target.side === "to" && binding.target.entity === write.entity));
    if (!resolution.outputs.every(output => writes.some(binding => binding.output === output))) return fail("Decision names an output not written by its data migration", change.id, "migration.invalidReference");
    const target = change.after;
    if (change.impact === "requiresDataCheck" && target?.kind === "column" && !writes.some(binding =>
        binding.target.side === "to" && binding.target.entity === target.parentName && binding.target.field === target.name)) {
        return fail("Data migration does not fill or transform the changed column", change.id, "migration.invalidReference");
    }
    if (change.differences.some(diff => diff.path[0] === "type") && change.before?.kind === "column"
        && (decision.source?.side !== "from" || decision.source.entity !== change.before.parentName || decision.source.field !== change.before.name)) {
        return fail("Type conversion must name and consume the changed source column", change.id, "migration.invalidReference");
    }
    return {ok: true, value: true};
}

/** Pure readiness: choices are bound to reconstructed change IDs; pending is derived. */
export function assessMigrationDecisions(changes: readonly StructureChangeInfo[], draft: Pick<MigrationDraftInfo, "decisions" | "data" | "manual">): ValidationResult<readonly PendingQuestionInfo[]> {
    const byId = new Map(changes.map(change => [change.id, change]));
    const groups = new Map<string, DataDecisionInfo[]>();
    for (const decision of draft.decisions) {
        const change = byId.get(decision.changeId);
        if (change === undefined || (change.impact !== "destructive" && change.impact !== "requiresDataCheck")) return fail("Decision is outside this migration's required changes", decision.changeId, "migration.invalidReference");
        if (change.impact === "destructive" && (decision.source === null ? change.affectedFields.length !== 0
            : !change.affectedFields.some(field => sameField(field, decision.source!)))) return fail("Decision source is not affected by this removal", change.id, "migration.invalidReference");
        if (decision.partitionCheck !== null && decision.partitionCheck.kind !== "check") return fail("Partition resource must be a check", change.id);
        if (change.impact === "requiresDataCheck" && decision.partitionCheck !== null) return fail("Required data changes need a complete resolution", change.id);
        const valid = validateResolution(change, decision, draft.data);
        if (!valid.ok) return valid;
        const key = decisionKey(change.id, change.impact === "destructive" ? decision.source : null);
        const matching = groups.get(key) ?? [];
        if (matching.some(previous => previous.partitionCheck === null || decision.partitionCheck === null
            || (previous.partitionCheck.name === decision.partitionCheck.name && previous.partitionCheck.contentHash === decision.partitionCheck.contentHash))) return fail("Duplicate or overlapping decisions", change.id);
        groups.set(key, [...matching, decision]);
    }
    const manual = new Set<string>();
    for (const step of draft.manual) {
        if (step.run.kind !== "sql") return fail("Manual resolution must reference SQL", step.id, "migration.invalidResourceKind");
        for (const id of step.implementsChanges) {
            const change = byId.get(id);
            if (change === undefined) return fail("Manual resolution references an unknown change", id, "migration.invalidReference");
            if (manual.has(id)) return fail("Structure change is claimed by more than one manual step", id);
            const identity = change.action === "remove" ? change.before : change.after;
            const effects = change.action === "remove" ? step.destroys : step.writes;
            if (identity === null || !effects.some(effect => samePgIdentity(effect, identity))) return fail("Manual effect contract does not cover the claimed structure change", id);
            manual.add(id);
        }
    }
    const pending: PendingQuestionInfo[] = [];
    for (const change of changes) {
        if (change.impact === "preserving") continue;
        if (change.impact === "destructive") {
            const sources = change.affectedFields.length ? change.affectedFields : [null];
            if (sources.every(source => groups.has(decisionKey(change.id, source)))) continue;
        } else {
            if (manual.has(change.id)) continue;
            if (change.impact === "requiresDataCheck") {
                if (groups.has(decisionKey(change.id, null))) continue;
                if (changes.some(table => table.action === "add" && table.after?.kind === "table" && table.after.schema === change.after?.schema && table.after.name === change.after?.parentName)) continue;
            }
        }
        pending.push({id: change.id, kind: change.impact === "destructive" ? "destructive" : change.impact === "unsupported" ? "unsupported" : "dataRequired",
            subjects: [change.id], messageKey: change.impact === "destructive" ? "migration.destructiveDecisionRequired" : "migration.authoringPending"});
    }
    return {ok: true, value: pending};
}

/** Gate generation/application using recomputed differences, not draft.changes/pending. */
export function validateMigrationDecisions(changes: readonly StructureChangeInfo[], draft: Pick<MigrationDraftInfo, "decisions" | "data" | "manual">): ValidationResult<true> {
    const assessed = assessMigrationDecisions(changes, draft);
    if (!assessed.ok) return assessed;
    if (assessed.value.length === 0) return {ok: true, value: true};
    return {ok: false, problems: [problem(null, assessed.value.some(question => question.kind === "unsupported")
        ? "migration.unsupportedSchemaFeature" : "migration.authoringPending", "blocking", {
        changeIds: assessed.value.map(question => question.id).join(","), reason: "Migration has unresolved decisions",
    })]};
}

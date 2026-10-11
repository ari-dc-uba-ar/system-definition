import {problem, type ValidationResult} from "system-definition";
import type {DataDecisionInfo, FieldRefInfo, MigrationDraftInfo, PendingQuestionInfo, StructureChangeInfo} from "./authoring-contract";
import type {DataMigrationInfo} from "./migration-authoring";

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
    const manual = new Set(draft.manual.flatMap(step => step.implementsChanges));
    for (const id of manual) if (!byId.has(id)) return fail("Manual resolution references an unknown change", id, "migration.invalidReference");
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

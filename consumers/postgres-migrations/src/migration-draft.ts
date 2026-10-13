import {decodeArray, hasExactKeys, isNonEmptyString, isPlainObject, isSha256, problem, toJsonValue, type StructuralFailure, type ValidationResult} from "system-definition";
import {decodeAuthoringBase, decodeDataDecisionInfo, decodeManualStepInfo, type AuthoringBaseInfo, type MigrationDraftInfo, type RenameInfo, type StructureChangeInfo} from "./authoring-contract";
import type {PgSchemaInfo} from "./pg-schema";
import {projectSsotSchema, type SqlSsotInfo} from "./sql-mapping";
import {inferStructureChanges} from "./infer";
import {assessMigrationDecisions} from "./migration-decisions";
import {decodeDataMigrationShape, decodeFieldRefInfo, decodeNames} from "./data-authoring-codec";
import {decodePgObjectIdentity} from "./pg-identity";
import {computeDraftRevisionHash} from "./draft-revision";

/** Create editable choices from the supplied SSOT and source schema. */
export function createMigrationDraft(id: string, base: AuthoringBaseInfo, current: PgSchemaInfo, target: SqlSsotInfo, schema: string): ValidationResult<MigrationDraftInfo> {
    if (id.trim().length === 0 || base.from.systemId !== target.ssot.systemId || base.to.systemId !== target.ssot.systemId) return {ok: false, problems: [problem(null, "migration.invalidReference", "blocking", {reason: "Supply a migration id and endpoints for this SSOT"})]};
    const desired = projectSsotSchema(target, schema);
    if (!desired.ok) return desired;
    const changes = inferStructureChanges(base, current, desired.value, []);
    if (!changes.ok) return changes;
    const draft: MigrationDraftInfo = {formatVersion: 1, id, base, revisionHash: "", changes: changes.value, renames: [], data: [], decisions: [], manual: [], pending: []};
    const pending = assessMigrationDecisions(changes.value, draft), revision = computeDraftRevisionHash(draft);
    if (!pending.ok) return pending;
    return revision.ok ? {ok: true, value: {...draft, pending: pending.value, revisionHash: revision.value}} : revision;
}

function decodeRename(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<RenameInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["before", "after"]) || !isPlainObject(value.before) || !isPlainObject(value.after)) return invalid(path, "invalid rename");
    if (Object.hasOwn(value.before, "field")) {
        const before = decodeFieldRefInfo(value.before, path + ".before", invalid); if (!before.ok) return before;
        const after = decodeFieldRefInfo(value.after, path + ".after", invalid); if (!after.ok) return after;
        if (before.value.side !== "from" || after.value.side !== "to") return invalid(path, "rename must go from the old snapshot to the new one");
        return {ok: true, value: {before: {...before.value, side: "from" as const}, after: {...after.value, side: "to" as const}}};
    }
    if (!hasExactKeys(value.before, ["entity"]) || !hasExactKeys(value.after, ["entity"]) || !isNonEmptyString(value.before.entity) || !isNonEmptyString(value.after.entity)) return invalid(path, "invalid entity rename");
    return {ok: true, value: {before: {entity: value.before.entity}, after: {entity: value.after.entity}}};
}

function decodeChange(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<StructureChangeInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["id", "origin", "impact", "differences", "affectedFields", "dependsOn", "action", "before", "after"])
        || !isNonEmptyString(value.id) || (value.origin !== "inferred" && value.origin !== "authored")
        || (value.impact !== "preserving" && value.impact !== "requiresDataCheck" && value.impact !== "destructive" && value.impact !== "unsupported")) return invalid(path, "invalid structure change");
    const before = value.before === null ? {ok: true as const, value: null} : decodePgObjectIdentity(value.before, path + ".before", invalid); if (!before.ok) return before;
    const after = value.after === null ? {ok: true as const, value: null} : decodePgObjectIdentity(value.after, path + ".after", invalid); if (!after.ok) return after;
    const differences = decodeArray(value.differences, path + ".differences", invalid, (raw, at) => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["path", "before", "after"])) return invalid(at, "invalid schema difference");
        const parts = decodeArray(raw.path, at + ".path", invalid, (part, partPath) => typeof part === "string" ? {ok: true, value: part} : invalid(partPath, "expected a path segment"));
        if (!parts.ok) return parts;
        const old = toJsonValue(raw.before); if (!old.ok) return old;
        const next = toJsonValue(raw.after); if (!next.ok) return next;
        return {ok: true, value: {path: parts.value, before: old.value, after: next.value}};
    });
    if (!differences.ok) return differences;
    const affectedFields = decodeArray(value.affectedFields, path + ".affectedFields", invalid, (raw, at) => decodeFieldRefInfo(raw, at, invalid)); if (!affectedFields.ok) return affectedFields;
    const dependsOn = decodeNames(value.dependsOn, path + ".dependsOn", invalid); if (!dependsOn.ok) return dependsOn;
    const common = {id: value.id, origin: value.origin, impact: value.impact, differences: differences.value, affectedFields: affectedFields.value, dependsOn: dependsOn.value} satisfies Omit<StructureChangeInfo, "action" | "before" | "after">;
    switch (value.action) {
        case "add": if (before.value === null && after.value !== null) return {ok: true, value: {...common, action: value.action, before: null, after: after.value}}; break;
        case "remove": if (before.value !== null && after.value === null) return {ok: true, value: {...common, action: value.action, before: before.value, after: null}}; break;
        case "alter": case "rename": if (before.value !== null && after.value !== null) return {ok: true, value: {...common, action: value.action, before: before.value, after: after.value}}; break;
    }
    return invalid(path, "change action does not match its endpoints");
}

/** JSON becomes a typed draft here; assembly still reconstructs changes and validates decisions. */
export function decodeMigrationDraftInfo(value: unknown): ValidationResult<MigrationDraftInfo> {
    const invalid: StructuralFailure = (path, reason) => ({ok: false, problems: [problem(null, "migration.unsupportedFormat", "blocking", {path, reason})]});
    if (!isPlainObject(value) || !hasExactKeys(value, ["formatVersion", "id", "base", "revisionHash", "renames", "changes", "data", "decisions", "manual", "pending"])
        || value.formatVersion !== 1 || !isNonEmptyString(value.id) || !isSha256(value.revisionHash)) return invalid("$", "invalid migration draft");
    const base = decodeAuthoringBase(value.base, "base", invalid); if (!base.ok) return base;
    const renames = decodeArray(value.renames, "renames", invalid, (raw, at) => decodeRename(raw, at, invalid)); if (!renames.ok) return renames;
    const changes = decodeArray(value.changes, "changes", invalid, (raw, at) => decodeChange(raw, at, invalid)); if (!changes.ok) return changes;
    const data = decodeArray(value.data, "data", invalid, (raw, at) => decodeDataMigrationShape(raw, at, invalid)); if (!data.ok) return data;
    const decisions = decodeArray(value.decisions, "decisions", invalid, (raw, at) => decodeDataDecisionInfo(raw, at, invalid)); if (!decisions.ok) return decisions;
    const manual = decodeArray(value.manual, "manual", invalid, (raw, at) => decodeManualStepInfo(raw, at, invalid)); if (!manual.ok) return manual;
    const pending = decodeArray(value.pending, "pending", invalid, (raw, at): ValidationResult<MigrationDraftInfo["pending"][number]> => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["id", "kind", "subjects", "messageKey"]) || !isNonEmptyString(raw.id) || !isNonEmptyString(raw.messageKey)
            || (raw.kind !== "rename" && raw.kind !== "dataRequired" && raw.kind !== "destructive" && raw.kind !== "rowMapping" && raw.kind !== "unsupported")) return invalid(at, "invalid pending question");
        const subjects = decodeNames(raw.subjects, at + ".subjects", invalid);
        return subjects.ok ? {ok: true, value: {id: raw.id, kind: raw.kind, subjects: subjects.value, messageKey: raw.messageKey}} : subjects;
    });
    if (!pending.ok) return pending;
    return {ok: true, value: {formatVersion: 1, id: value.id, base: base.value, revisionHash: value.revisionHash,
        renames: renames.value, changes: changes.value, data: data.value, decisions: decisions.value, manual: manual.value, pending: pending.value}};
}

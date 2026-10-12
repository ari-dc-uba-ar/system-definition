import {problem, type ValidationResult} from "system-definition";
import type {AuthoringBaseInfo, MigrationDraftInfo} from "./authoring-contract";
import type {PgSchemaInfo} from "./pg-schema";
import {projectSsotSchema, type SqlSsotInfo} from "./sql-mapping";
import {inferStructureChanges} from "./infer";
import {assessMigrationDecisions} from "./migration-decisions";
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

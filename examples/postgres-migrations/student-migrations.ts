/* Three kinds of migration use one draft format. Inference describes structural changes;
   only the developer supplies the data transformation and decisions about discarded data. */
import type {ResourceRefInfo, SystemSnapshotInfo} from "system-definition";
import {
    buildSourceSelection, completeDataMigration, completeTransformation, computeDraftRevisionHash,
    inferStructureChanges, projectSchema, type AuthoringContext, type MigrationDraftInfo,
    type ReleaseVerificationInput,
} from "@system-definition/postgres-migrations";
import {legacySnapshot, expandedSnapshot, currentSnapshot} from "./students";
import {studentPersistence, studentStorage} from "./student-storage";
import {contentHash, textHash, valueOf} from "./support";

// These local example references identify immutable input content. Published applications
// obtain their release references from publishReleaseArtifact and replay the published path.
function release(releaseId: string, snapshot: SystemSnapshotInfo): ReleaseVerificationInput {
    return {ref: {systemId: snapshot.systemId, releaseId, releaseHash: contentHash({releaseId, snapshot, persistence: studentPersistence})},
        snapshot, persistence: studentPersistence, storage: studentStorage, inspection: {schemas: ["app"], excluded: []}};
}
export const legacyRelease = release("legacy", legacySnapshot);
export const expandedRelease = release("expanded", expandedSnapshot);
export const populatedRelease = release("populated", expandedSnapshot);
export const currentRelease = release("current", currentSnapshot);

function draft(from: ReleaseVerificationInput, to: ReleaseVerificationInput): MigrationDraftInfo {
    const base = {from: from.ref, to: to.ref,
        fromSnapshotHash: contentHash(from.snapshot), toSnapshotHash: contentHash(to.snapshot),
        fromPersistenceHash: contentHash(from.persistence), toPersistenceHash: contentHash(to.persistence)};
    return revise({formatVersion: 1, id: `${from.ref.releaseId}-${to.ref.releaseId}`, base, revisionHash: "",
        renames: [], data: [], decisions: [], manual: [], pending: [],
        changes: valueOf(inferStructureChanges(base,
            valueOf(projectSchema(from.snapshot, from.persistence, from.storage)),
            valueOf(projectSchema(to.snapshot, to.persistence, to.storage)), []))});
}
export function revise(value: MigrationDraftInfo): MigrationDraftInfo {
    return {...value, revisionHash: valueOf(computeDraftRevisionHash(value))};
}

// 1. Structural-only: adding nullable email preserves existing rows. No SQL is authored.
export const inferredDraft = draft(legacyRelease, expandedRelease);

const emptyContext: AuthoringContext = {from: legacySnapshot, to: currentSnapshot, transformations: {}};
export const emailSource = valueOf(buildSourceSelection(emptyContext, {
    queryName: "student-email-source", schema: "app", base: {entity: "students", alias: "s"}, joins: [],
    ports: {studentId: {alias: "s", field: "studentId"}, email: {alias: "s", field: "legacyEmail"}},
    identity: ["studentId"], coverageChecks: [],
}));
// SQL transformation reads only the private input relation. __source_id establishes lineage;
// the stable studentId output selects exactly the destination row to update.
export const copyEmailSql = 'SELECT i.__source_id, i."studentId", i.email FROM migration_input AS i;\n';
export const copyEmail = valueOf(completeTransformation(emptyContext, {
    name: "copy-email", version: "1", inputs: emailSource.selection.ports, parameters: {}, mode: "row",
    query: {name: "copy-student-email", kind: "query", contentHash: textHash(copyEmailSql)},
    outputs: {
        studentId: {domain: {side: "to", type: "integer", nullable: false}, field: {side: "to", entity: "students", field: "studentId"}},
        email: {domain: {side: "to", type: "text", nullable: true}, field: {side: "to", entity: "students", field: "email"}},
    },
}));
export const emailContext: AuthoringContext = {...emptyContext, transformations: {[copyEmail.name]: copyEmail}};
export const conservationSql = 'SELECT NOT EXISTS (SELECT 1 FROM app.students WHERE "legacyEmail" IS DISTINCT FROM email) AS ok;\n';
export const conservationCheck: ResourceRefInfo = {name: "student-email-conserved", kind: "check", contentHash: textHash(conservationSql)};
export const emailMigration = valueOf(completeDataMigration(emailContext, {
    id: "copy-email", description: "Preserve each historical email, including null and empty text",
    source: emailSource.selection, transformation: copyEmail.name, arguments: {},
    writes: [{kind: "update", entity: "students", values: [{output: "email", target: {side: "to", entity: "students", field: "email"}}],
        match: [{output: "studentId", targetField: "studentId"}], whenMissing: "error"}],
    conservationChecks: [conservationCheck],
}));

// 2. Data-only: the two releases have identical schemas. Inference cannot discover that
// historical email values must be copied; add-data records this explicit contract.
export const dataOnlyDraft = revise({...draft(expandedRelease, populatedRelease), data: [emailMigration]});

const retirement = draft(legacyRelease, currentRelease);
// 3. Destructive: enumerate every disappearing field and record a separate choice.
// SQL generation can then add email, copy/validate/conserve the values, and finally DROP.
export const destructiveDraft = revise({...retirement, data: [emailMigration],
    decisions: retirement.changes.filter(change => change.impact === "destructive").flatMap(change =>
        change.affectedFields.map(source => ({changeId: change.id, source, partitionCheck: null,
            resolution: source.field === "legacyEmail"
                ? {kind: "migrate" as const, dataMigrationId: emailMigration.id, outputs: ["email"]}
                : {kind: "discard" as const, reason: "The retired note is no longer required by this example system"}}))),
});

// Handwritten SQL stays bound to the same SSOT. It declares the inferred effect it implements;
// the compiler replays it, infers any remaining differences, and verifies the combined result.
export const manualSql = 'ALTER TABLE app.students ADD COLUMN email text;\n';
export const manualRef: ResourceRefInfo = {name: "manual-email-column", kind: "sql", contentHash: textHash(manualSql)};
const emailAddition = inferredDraft.changes.find(change => change.after?.kind === "column" && change.after.name === "email")!;
export const manualDraft = revise({...inferredDraft, manual: [{id: "add-email", run: manualRef,
    dependsOn: [], implementsChanges: [emailAddition.id], reads: [], writes: [emailAddition.after!], destroys: [],
    before: [], after: [], rowChecks: []}]});

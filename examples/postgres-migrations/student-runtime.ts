/* Application wiring is deliberately separate from the serializable descriptions.
   This uses an owned scratch database: generation never changes an installation. */
import {resolve} from "node:path";
import {AuthoringFiles, buildValidationArtifact, createPostgresAuthoringRuntime, createPostgresScratch,
    type MigrationProject, type ReleaseVerificationInput, type ValidationArtifactInfo} from "@system-definition/postgres-migrations";
import {copyEmail, emailSource, copyEmailSql, conservationCheck, conservationSql, manualRef, manualSql,
    destructiveDraft, inferredDraft, dataOnlyDraft, manualDraft, legacyRelease, expandedRelease, populatedRelease, currentRelease} from "./student-migrations";
import {studentPersistence, studentStorage} from "./student-storage";
import {valueOf} from "./support";

export type StudentExample = "inferred" | "data" | "destructive" | "manual";
export async function studentProject(kind: StudentExample = "destructive"): Promise<MigrationProject> {
    const draft = {inferred: inferredDraft, data: dataOnlyDraft, destructive: destructiveDraft, manual: manualDraft}[kind];
    const source = kind === "data" ? expandedRelease : legacyRelease;
    const target = kind === "data" ? populatedRelease : kind === "destructive" ? currentRelease : expandedRelease;
    const files = new AuthoringFiles();
    for (const resource of [
        {ref: emailSource.selection.query, text: emailSource.sql}, {ref: copyEmail.query, text: copyEmailSql},
        {ref: conservationCheck, text: conservationSql}, {ref: manualRef, text: manualSql},
    ]) valueOf(await files.emitResource(resource));
    const context = {from: source.snapshot, to: target.snapshot, transformations: {[copyEmail.name]: copyEmail}};
    const validationArtifacts: ValidationArtifactInfo[] = [];
    // Both historical validators are bundled and hashed. Future behaviour changes cannot
    // silently change what a published migration accepts. Each entry imports only validation.
    const entryFor = (release: ReleaseVerificationInput): string => release === legacyRelease ? "legacy"
        : release === currentRelease ? "current" : "expanded";
    for (const side of ["from", "to"] as const) {
        const release = side === "from" ? source : target;
        const built = await buildValidationArtifact(resolve(__dirname, `../validation-${entryFor(release)}.ts`), side,
            release.snapshot, side === "from" ? draft.base.fromSnapshotHash : draft.base.toSnapshotHash);
        files.files.set(built.info.entry.path, built.bytes);
        validationArtifacts.push(built.info);
    }
    const runtime = createPostgresAuthoringRuntime({source, target, files,
        data: async () => ({ok: true, value: {context, persistence: studentPersistence, storage: studentStorage, validationArtifacts}}),
        scratch: createPostgresScratch({}, ["app"]),
        // This small example begins at a recorded baseline. An existing application supplies
        // its authentic baseline/path/context resolver; reconstructHistory replays that path.
        history: {baseline: source, path: {from: source.ref, to: source.ref, migrations: []},
            resolveContext() { throw new Error("The example baseline has no preceding migration"); }},
        async fixture(session) {
            for (const [index, email] of ["person@example.org", "", null, "null", "o'hara@example.org"].entries()) {
                await session.query('INSERT INTO app.students ("studentId", name, "legacyEmail", "legacyNote") VALUES ($1,$2,$3,$4)',
                    [index + 1, `Student ${index + 1}`, email, "Retired note"]);
            }
            return {ok: true, value: true};
        },
    });
    return {authoring: {draft, context, files, runtime}};
}

// Runnable CLI module: postgres-migrations generate --project <this compiled file> --out <new directory>.
// Other scenarios are selected by importing studentProject("inferred" | "data" | "manual").
export const createMigrationProject = () => studentProject("destructive");

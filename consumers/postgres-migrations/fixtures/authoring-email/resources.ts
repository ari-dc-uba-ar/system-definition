import {resolve} from "node:path";
import {AuthoringFiles} from "../../src/authoring-files";
import {buildValidationArtifact} from "../../src/build-validation";
import type {ValidationArtifactInfo} from "../../src/validation-artifact";
import type {AuthoringRuntime} from "../../src/authoring-contract";
import {
    authoringEmailBase, authoringEmailContext, authoringEmailPersistence, authoringEmailStorage,
    authoringEmailSource, authoringEmailTransformationQuery, authoringEmailTransformationSql,
    authoringEmailConservationSql, authoringEmailConservationCheck,
} from "./index";

export async function authoringEmailResources() {
    const files = new AuthoringFiles();
    await files.emitResource({ref: authoringEmailSource.selection.query, text: authoringEmailSource.sql});
    await files.emitResource({ref: authoringEmailTransformationQuery, text: authoringEmailTransformationSql});
    await files.emitResource({ref: authoringEmailConservationCheck, text: authoringEmailConservationSql});
    const validationArtifacts: ValidationArtifactInfo[] = [];
    for (const side of ["from", "to"] as const) {
        const built = await buildValidationArtifact(
            resolve(__dirname, `../../../fixtures/authoring-email/validation-${side}.ts`), side,
            authoringEmailContext[side], side === "from" ? authoringEmailBase.fromSnapshotHash : authoringEmailBase.toSnapshotHash,
        );
        files.files.set(built.info.entry.path, built.bytes);
        validationArtifacts.push(built.info);
    }
    const loadDataContext: NonNullable<AuthoringRuntime["loadDataContext"]> = async () => ({ok: true, value: {
        context: authoringEmailContext, persistence: authoringEmailPersistence, storage: authoringEmailStorage, validationArtifacts,
    }});
    return {files, loadDataContext};
}

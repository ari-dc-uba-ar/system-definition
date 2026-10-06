import {
    sameReleaseRef,
    type ReleaseRefInfo,
    type ValidationResult,
} from "system-definition";
import {
    hasWellFormedRehearsalCopyIdentity,
    type RehearsalCopyRef,
} from "./rehearsal-copy";
import type {PreparationArtifactInfo} from "./preparation-artifact";
import {invalidPreparation as fail} from "./preparation-error";

export type PreparationPreflightStateInfo = {
    copy: RehearsalCopyRef;
    installationId: string;
    head: ReleaseRefInfo;
    historyHash: string;
    observedSchemaHash: string;
    inputFingerprint: string;
    requestedPlanHash: string;
};

export type PreparationCurrentStateInfo = Omit<PreparationPreflightStateInfo, "copy">;


export function checkPreparationPreconditions(
    artifact: PreparationArtifactInfo,
    state: PreparationPreflightStateInfo,
): ValidationResult<true> {
    if (!hasWellFormedRehearsalCopyIdentity(state.copy)) return fail("invalid identified copy");
    if (artifact.installationId !== state.installationId
        || state.copy.installationId !== artifact.installationId
        || !sameReleaseRef(state.copy.source, artifact.head)
        || !sameReleaseRef(state.head, artifact.head)
        || artifact.historyHash !== state.historyHash
        || artifact.observedSchemaHash !== state.observedSchemaHash
        || artifact.inputFingerprint !== state.inputFingerprint
        || artifact.requestedPlanHash !== state.requestedPlanHash) {
        return fail("preparation preconditions changed");
    }
    return {ok: true, value: true};
}

export function checkCurrentPreparationPreconditions(
    artifact: PreparationArtifactInfo,
    state: PreparationCurrentStateInfo,
): ValidationResult<true> {
    if (artifact.installationId !== state.installationId
        || !sameReleaseRef(state.head, artifact.head)
        || artifact.historyHash !== state.historyHash
        || artifact.observedSchemaHash !== state.observedSchemaHash
        || artifact.inputFingerprint !== state.inputFingerprint
        || artifact.requestedPlanHash !== state.requestedPlanHash) {
        return fail("preparation preconditions changed");
    }
    return {ok: true, value: true};
}

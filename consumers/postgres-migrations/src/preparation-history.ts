import {
    toJsonValue,
    type ValidationResult,
} from "system-definition";
import {
    readPreparationHistory,
    type JournalConfig,
    type PreparationHistoryInfo,
} from "./journal";
import type {PgSession} from "./pg-schema";
import {canonicalJsonSha256} from "./canonical-hash";

export type PreparationHistoryEntryInfo = {
    ordinal: number;
    preparationId: string;
    artifactHash: string;
    headReleaseHash: string;
    beforeFingerprint: string;
    afterFingerprint: string;
};

export function computePreparationHistoryHash(
    history: readonly PreparationHistoryEntryInfo[],
): string {
    const converted = toJsonValue(history);
    if (!converted.ok) throw new TypeError("preparation history is not strict JSON");
    return canonicalJsonSha256(converted.value);
}

export function preparationHistoryEntries(
    history: readonly PreparationHistoryInfo[],
): readonly PreparationHistoryEntryInfo[] {
    return history.map(one => ({
        ordinal: one.ordinal,
        preparationId: one.preparationId,
        artifactHash: one.artifactHash,
        headReleaseHash: one.head.releaseHash,
        beforeFingerprint: one.beforeFingerprint,
        afterFingerprint: one.afterFingerprint,
    }));
}

export async function readPreparationHistoryHash(
    session: PgSession,
    journal: JournalConfig,
    installationId: string,
): Promise<ValidationResult<string>> {
    const history = await readPreparationHistory(session, journal, installationId);
    if (!history.ok) return history;
    return {ok: true, value: computePreparationHistoryHash(preparationHistoryEntries(history.value))};
}

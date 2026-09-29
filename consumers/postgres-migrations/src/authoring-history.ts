import {
    problem,
    type ValidationResult,
} from "system-definition";
import {compareSchemas} from "./compare-schema";
import type {PgSchemaInfo} from "./pg-schema";
import {
    verifyUpgrade,
    type ReleaseVerificationInput,
    type ScratchProvider,
    type UpgradeVerificationInput,
} from "./verify";

export type HistoryReconstructionInput = Omit<UpgradeVerificationInput, "fixture">;

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

/**
 * Reconstruct the schema recorded by migration history using the same owned
 * scratch verification route used by T13.  The synthetic fixture is deliberately
 * empty: T18 is proving structural history here, while data proof remains owned
 * by the published migration checks and the T13 runner.
 */
export async function reconstructHistory(
    input: HistoryReconstructionInput,
    scratch: ScratchProvider,
): Promise<ValidationResult<PgSchemaInfo>> {
    const verified = await verifyUpgrade({
        ...input,
        fixture: {
            id: "authoring-history-structure",
            async load(): Promise<ValidationResult<true>> {
                return {ok: true, value: true};
            },
            async verify(): Promise<ValidationResult<true>> {
                return {ok: true, value: true};
            },
        },
    }, scratch);
    if (!verified.ok) return verified;
    return {ok: true, value: verified.value.upgradedTarget};
}

/** Compare an installation with the schema of its own confirmed history head. */
export function checkHistoryHeadDrift(
    historyHead: PgSchemaInfo,
    observed: PgSchemaInfo,
): ValidationResult<true> {
    const compared = compareSchemas(historyHead, {
        schema: observed,
        unknown: [],
        excluded: [],
    });
    if (!compared.ok) return compared;
    if (compared.value.equal) return {ok: true, value: true};

    const first = compared.value.differences[0];
    return fail("migration.schemaDrift", {
        path: first === undefined ? "schema" : first.path.join("."),
        differenceCount: String(compared.value.differences.length),
    });
}

/** Authoring is always directed at an explicit SSOT release, never observed state. */
export function requireDesiredRelease(
    desired: ReleaseVerificationInput | null,
): ValidationResult<ReleaseVerificationInput> {
    if (desired === null) {
        return fail("migration.invalidReference", {
            reason: "authoring requires an explicit desired SSOT release",
        });
    }
    return {ok: true, value: desired};
}

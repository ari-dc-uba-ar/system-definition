import {completeMigrationCatalog, problem, sameReleaseRef, type MigrationCatalogInfo, type PublishedMigrationInfo, type ValidationResult} from "system-definition";
import {readHistoryState, verifyHistory} from "./journal-history";
import type {InstallationInfo, InstallationScope, JournalConfig, MigrationHistoryInfo} from "./journal-contracts";
import type {PgSchemaInfo, PgSession} from "./pg-schema";
import {inspectSchema, type InspectionInfo} from "./inspect-schema";
import {normalizePgSchema} from "./normalize-schema";
import {compareSchemas} from "./compare-schema";

export type MigrationHistoryStateInfo = {
    installation: InstallationInfo | null;
    migrations: readonly (PublishedMigrationInfo & {position: number; applied: boolean})[];
};
function fail(reason: string, key = "migration.invalidJournal"): ValidationResult<never> {
    return {ok: false, problems: [problem(null, key, "blocking", {reason})]};
}

/** Applied entries must be an unchanged prefix of the saved, ordered catalog. */
export function describeMigrationHistory(installation: InstallationInfo | null, history: readonly MigrationHistoryInfo[], catalog: MigrationCatalogInfo): ValidationResult<MigrationHistoryStateInfo> {
    const checked = completeMigrationCatalog(catalog.releases, catalog.migrations);
    if (!checked.ok) return checked;
    if (checked.value.systemId !== catalog.systemId) return fail("Catalog system does not match its releases", "migration.invalidCatalog");
    if (installation === null) {
        if (history.length > 0) return fail("Committed migrations require an installation pointer");
    } else {
        const verified = verifyHistory(installation, history);
        if (!verified.ok) return verified;
        if (!sameReleaseRef(installation.baseline, checked.value.releases[0]!)) return fail("Catalog does not start at the installed baseline", "migration.invalidCatalog");
        for (const [index, applied] of history.entries()) {
            const saved = checked.value.migrations[index];
            if (saved === undefined || saved.migration.id !== applied.migrationId || saved.migrationHash !== applied.migrationHash
                || !sameReleaseRef(saved.migration.from, applied.from) || !sameReleaseRef(saved.migration.to, applied.to)) return fail("Applied migration was removed, reordered or changed", "migration.checksumMismatch");
        }
    }
    return {ok: true, value: {installation, migrations: checked.value.migrations.map((migration, index) => ({...migration, position: index + 1, applied: index < history.length}))}};
}

/** Compare with the recorded head, never the next desired SSOT. */
export async function checkHistoryHeadDrift(expected: PgSchemaInfo, observed: InspectionInfo): Promise<ValidationResult<true>> {
    const compared = compareSchemas(await normalizePgSchema(expected), {...observed, schema: await normalizePgSchema(observed.schema)});
    if (!compared.ok) return compared;
    return compared.value.equal ? {ok: true, value: true} : fail("Database differs from its last applied migration; reconcile it before planning or applying another", "migration.schemaDrift");
}

export async function readMigrationHistory(session: PgSession, config: JournalConfig, scope: InstallationScope, catalog: MigrationCatalogInfo, schemas: Readonly<Record<string, PgSchemaInfo>>): Promise<ValidationResult<MigrationHistoryStateInfo>> {
    if (catalog.systemId !== scope.systemId) return fail("Catalog belongs to another application", "migration.invalidCatalog");
    const state = await readHistoryState(session, config, scope);
    if (!state.ok) return state;
    const described = describeMigrationHistory(state.value.installation, state.value.history, catalog);
    if (!described.ok || described.value.installation === null) return described;
    const expected = schemas[described.value.installation.current.releaseHash];
    if (expected === undefined) return fail("Missing saved schema for the applied database head", "migration.invalidReference");
    const observed = await inspectSchema(session, {schemas: scope.schemas, excluded: []});
    if (!observed.ok) return observed;
    const drift = await checkHistoryHeadDrift(expected, observed.value);
    return drift.ok ? described : drift;
}

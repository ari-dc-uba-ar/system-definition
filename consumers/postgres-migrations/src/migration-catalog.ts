import {completeMigrationCatalog, type MigrationCatalogInfo, type PublishedMigrationInfo, type ReleaseRefInfo, type ValidationResult} from "system-definition";
import {loadMigrationManifest} from "./migration-artifact";

/** The caller supplies the saved baseline and directory order; never guess from filenames. */
export async function readMigrationCatalog(baseline: ReleaseRefInfo, directories: readonly string[]): Promise<ValidationResult<MigrationCatalogInfo>> {
    const releases = [baseline], migrations: PublishedMigrationInfo[] = [];
    for (const directory of directories) {
        const loaded = await loadMigrationManifest(directory);
        if (!loaded.ok) return loaded;
        migrations.push({migration: loaded.value.migration, migrationHash: loaded.value.migrationHash});
        releases.push(loaded.value.migration.to);
    }
    return completeMigrationCatalog(releases, migrations);
}

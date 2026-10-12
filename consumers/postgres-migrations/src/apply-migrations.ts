import {randomUUID} from "node:crypto";
import {problem, type ValidationResult} from "system-definition";
import type {DatabaseSettings} from "./database-settings";
import {provisionDatabase, grantAppPermissions, verifyDatabasePermissions} from "./database-permissions";
import {connectPostgres} from "./pg-session";
import {bootstrapJournal, finishAttempt, installBaseline, readHistoryState, readAttempt, startAttempt, withMigrationLock} from "./journal";
import {describeMigrationHistory, checkHistoryHeadDrift} from "./migration-history";
import {inspectSchema} from "./inspect-schema";
import {executeMigration, type MigrationExecutionContext} from "./execute-migration";
import {resolveMigrationExecutionContext} from "./migration-plan-runtime";
import {verifyMigrationFiles} from "./migration-integrity";
import {openArtifactDirectory} from "./artifact-files";
import {readArtifactJson, sha256Hex} from "./artifact";
import {quotePgIdentifier} from "./pg-sql";
import {reconcileCommitOutcome} from "./recovery";
import {invalidStore, jsonBytes, migrationDirectory, readCatalogState, readStateBytes, stateReference, type StoredMigrationCatalog} from "./migration-store";
import type {PgSession, ResolvedSqlResource} from "./pg-schema";

const failure = (error: unknown): ValidationResult<never> => ({ok: false, problems: [problem(null, "migration.executionFailed", "blocking", {reason: error instanceof Error ? error.message : String(error)})]});
const journalFor = (settings: DatabaseSettings) => ({schema: settings.database.schema + "_migrations"});
const scopeFor = (catalog: StoredMigrationCatalog, settings: DatabaseSettings) => ({systemId: catalog.systemId, schemas: [settings.database.schema]});

async function checkedStatus(root: string, catalog: StoredMigrationCatalog, settings: DatabaseSettings, session: PgSession) {
    const scope = scopeFor(catalog, settings);
    const history = await readHistoryState(session, journalFor(settings), scope);
    if (!history.ok) return history;
    const status = describeMigrationHistory(history.value.installation, history.value.history, catalog);
    if (!status.ok) return status;
    const expected = await readCatalogState(root, catalog, history.value.history.length);
    if (!expected.ok) return expected;
    const observed = await inspectSchema(session, {schemas: scope.schemas, excluded: []});
    if (!observed.ok) return observed;
    const drift = await checkHistoryHeadDrift(expected.value.schema, observed.value);
    return drift.ok ? status : drift;
}

export async function migrationStatus(root: string, catalog: StoredMigrationCatalog, settings: DatabaseSettings) {
    const session = await connectPostgres({...settings.database, ...settings.owner});
    try {return await checkedStatus(root, catalog, settings, session);} finally {await session.close();}
}
const attemptLockSql = (tryLock: boolean) => `SELECT ${tryLock ? "pg_try_advisory_lock" : "pg_advisory_lock"}(hashtextextended(current_database() || ':operation:' || $1, 0)) AS acquired`;
const releaseAttemptLockSql = "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':operation:' || $1, 0))";

// The lock connection remains outside operation transactions and survives their failures.
export async function applyMigrations(root: string, catalog: StoredMigrationCatalog, settings: DatabaseSettings) {
    if (catalog.systemId !== catalog.releases[0]?.systemId) return invalidStore("Invalid catalog", "migration.invalidCatalog");
    for (const migration of catalog.migrations) {
        const verified = await verifyMigrationFiles(migrationDirectory(root, migration), migration);
        if (!verified.ok) return verified;
    }
    const journal = journalFor(settings), scope = scopeFor(catalog, settings);
    let initialized = false;
    try {
        const existing = await connectPostgres({...settings.database, ...settings.owner});
        try {
            const result = await existing.query("SELECT to_regclass($1) IS NOT NULL AS present", [quotePgIdentifier(journal.schema) + ".installation"]);
            initialized = result.rows[0]?.present === true;
        } finally {await existing.close();}
    } catch { /* Initial owner may not exist; the administrative setup verifies roles/schema. */ }
    if (!initialized) {
        const setup = await withMigrationLock({openTarget: () => connectPostgres({...settings.database, ...settings.initialUser})}, scope, 5000,
            session => provisionDatabase(session, settings, journal.schema));
        if (!setup.ok) return setup;
    }
    return withMigrationLock({openTarget: () => connectPostgres({...settings.database, ...settings.owner})}, scope, 5000, async lock => {
        const bootstrapped = await bootstrapJournal(lock, journal);
        if (!bootstrapped.ok) return bootstrapped;
        const before = await readHistoryState(lock, journal, scope);
        if (!before.ok) return before;
        if (before.value.installation === null) {
            const expected = await readCatalogState(root, catalog, 0);
            if (!expected.ok) return expected;
            const observed = await inspectSchema(lock, {schemas: scope.schemas, excluded: []});
            if (!observed.ok) return observed;
            const drift = await checkHistoryHeadDrift(expected.value.schema, observed.value);
            if (!drift.ok) return drift;
            await lock.query("BEGIN", []);
            let commitSent = false;
            try {
                const installed = await installBaseline(lock, journal, {installationId: randomUUID(), scope, baseline: catalog.releases[0]});
                if (!installed.ok) {await lock.query("ROLLBACK", []); return installed;}
                commitSent = true;
                await lock.query("COMMIT", []);
            } catch (error) {
                if (commitSent) return invalidStore("Baseline commit result is unknown; reread the database pointer", "migration.commitUnknown");
                try {await lock.query("ROLLBACK", []);} catch {return invalidStore("Baseline rollback result is unknown", "migration.rollbackUnknown");}
                return failure(error);
            }
        }
        const status = await checkedStatus(root, catalog, settings, lock);
        if (!status.ok || status.value.installation === null) return status;
        const unfinished = await lock.query(`SELECT attempt_id, plan_hash FROM ${quotePgIdentifier(journal.schema)}.execution_attempt WHERE installation_id = $1 AND state IN ('running', 'unknown')`, [status.value.installation.installationId]);
        for (const row of unfinished.rows) {
            if (typeof row.attempt_id !== "string") return invalidStore("Invalid execution attempt");
            const published = catalog.migrations.find(migration => migration.migrationHash === row.plan_hash);
            if (published === undefined) return invalidStore("Unfinished attempt refers to a missing migration");
            const attempt = await readAttempt(lock, journal, row.attempt_id);
            if (!attempt.ok) return attempt;
            if (attempt.value.problems.some(one => one.messageKey === "migration.connectionCloseUnknown")) return invalidStore("Confirm the previous operation connection closed before reconciliation", "migration.commitUnknown");
            const inactive = await lock.query(attemptLockSql(true), [row.attempt_id]);
            if (inactive.rows[0]?.acquired !== true) return invalidStore("Previous migration operation is still connected", "migration.commitUnknown");
            let outcome;
            try {outcome = await reconcileCommitOutcome(lock, row.attempt_id, published, {journal, scope});}
            finally {await lock.query(releaseAttemptLockSql, [row.attempt_id]);}
            if (!outcome.ok) return outcome;
            if (outcome.value.state === "unknown") return {ok: false as const, problems: outcome.value.problems};
        }
        const refreshed = await checkedStatus(root, catalog, settings, lock);
        if (!refreshed.ok || refreshed.value.installation === null) return refreshed;
        const headState = await readCatalogState(root, catalog, refreshed.value.migrations.filter(migration => migration.applied).length);
        if (!headState.ok) return headState;
        const permissions = await verifyDatabasePermissions(lock, settings, headState.value.schema);
        if (!permissions.ok) return permissions;
        for (const pending of refreshed.value.migrations.filter(migration => !migration.applied)) {
            const directory = migrationDirectory(root, pending);
            const verified = await verifyMigrationFiles(directory, pending);
            if (!verified.ok) return verified;
            const reader = await openArtifactDirectory(directory);
            if (!reader.ok) return reader;
            const saved = verified.value.authoring.states;
            if (saved === undefined) return invalidStore("Missing saved migration states");
            const sourceBytes = await reader.value.readVerified(saved.from), targetBytes = await reader.value.readVerified(saved.to);
            if (!sourceBytes.ok) return sourceBytes;
            if (!targetBytes.ok) return targetBytes;
            const source = await readStateBytes(sourceBytes.value), target = await readStateBytes(targetBytes.value);
            if (!source.ok) return source;
            if (!target.ok) return target;
            const recordedSource = await readCatalogState(root, catalog, pending.position - 1);
            if (!recordedSource.ok) return recordedSource;
            if (stateReference(source.value).releaseHash !== stateReference(recordedSource.value).releaseHash) return invalidStore("Saved source differs from its catalog state", "migration.checksumMismatch");
            if (stateReference(target.value).releaseHash !== pending.migration.to.releaseHash) return invalidStore("Saved target differs from migration destination", "migration.checksumMismatch");
            if (source.value.namespace !== settings.database.schema || target.value.namespace !== settings.database.schema) return invalidStore("Namespace differs from database settings");
            const resources: Record<string, ResolvedSqlResource> = Object.create(null);
            for (const ref of [...pending.migration.before, ...pending.migration.steps.map(step => step.run), ...pending.migration.after, ...verified.value.authoring.checkpoints.flatMap(checkpoint => checkpoint.checks)]) {
                const bytes = await reader.value.read(`generated/${ref.contentHash}.sql`);
                if (!bytes.ok) return bytes;
                if (sha256Hex(bytes.value) !== ref.contentHash) return invalidStore("Resource changed", "migration.checksumMismatch");
                resources[ref.name] = {ref, text: new TextDecoder("utf-8", {fatal: true}).decode(bytes.value)};
            }
            const state = (schema: typeof source.value.schema) => ({expectedSchema: schema, inspection: {schemas: scope.schemas, excluded: []}, managedData: [], invariantChecks: []});
            const base: Omit<MigrationExecutionContext, "authoring"> = {journal, scope, resources, from: state(source.value.schema),
                to: {...state(target.value.schema), async verifyPermissions(session) {
                    const granted = await grantAppPermissions(session, settings, target.value.schema);
                    return granted.ok ? verifyDatabasePermissions(session, settings, target.value.schema) : granted;
                }}, options: {statementTimeoutMs: 30000, lockTimeoutMs: 5000}, now: () => new Date().toISOString()};
            const context = await resolveMigrationExecutionContext(pending, base, {
                loadMigrationManifest: () => readArtifactJson(reader.value, "migration.json", false),
                readMigrationFile: (_migration, file) => reader.value.readVerified(file),
                snapshots: {from: {snapshot: source.value.ssot, snapshotHash: sha256Hex(jsonBytes(source.value.ssot))}, to: {snapshot: target.value.ssot, snapshotHash: sha256Hex(jsonBytes(target.value.ssot))}},
                nodeVersion: process.version,
                async importValidationModule(entry) {
                    const bytes = await reader.value.readVerified(entry);
                    if (!bytes.ok) throw new Error(JSON.stringify(bytes.problems));
                    return import("data:text/javascript;base64," + Buffer.from(bytes.value).toString("base64") + "#" + entry.contentHash);
                },
            });
            if (!context.ok) return context;
            const attemptId = randomUUID();
            const attemptInput = {attemptId, deploymentId: pending.migration.id, installationId: refreshed.value.installation.installationId, planHash: pending.migrationHash};
            const opened: ValidationResult<PgSession> = await connectPostgres({...settings.database, ...settings.owner})
                .then(value => ({ok: true as const, value}), failure);
            let ready = opened;
            if (opened.ok) {
                try {await opened.value.query(attemptLockSql(false), [attemptId]);}
                catch (error) {ready = failure(error);}
            }
            let executed: ValidationResult<unknown>;
            try {
                const started = await startAttempt(lock, journal, attemptInput);
                if (!started.ok) return started;
                executed = ready.ok ? await executeMigration(ready.value, pending, context.value) : ready;
            } catch (error) {executed = failure(error);}
            finally {
                if (opened.ok) try {await opened.value.close();}
                catch {executed = {ok: false, problems: [problem(null, "migration.connectionCloseUnknown", "blocking")]};}
            }
            const unknown = !executed.ok && executed.problems.some(one => ["migration.commitUnknown", "migration.rollbackUnknown", "migration.connectionCloseUnknown"].includes(one.messageKey));
            const finished = await finishAttempt(lock, journal, attemptId, {state: executed.ok ? "succeeded" : unknown ? "unknown" : "failed", confirmedTarget: executed.ok ? pending.migration.to : null, problems: executed.ok ? [] : executed.problems});
            if (!finished.ok) return finished;
            if (unknown && !executed.ok && !executed.problems.some(one => one.messageKey === "migration.connectionCloseUnknown")) {
                const outcome = await reconcileCommitOutcome(lock, attemptId, pending, {journal, scope});
                if (!outcome.ok) return outcome;
                if (outcome.value.state === "succeeded") continue;
            }
            if (!executed.ok) return executed;
        }
        return checkedStatus(root, catalog, settings, lock);
    });
}

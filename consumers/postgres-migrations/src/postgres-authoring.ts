import {problem, sameReleaseRef, type MigrationPathInfo, type ValidationResult} from "system-definition";
import {canonicalJson, toJsonValue} from "system-definition";
import {createHash} from "node:crypto";
import {AuthoringFiles} from "./authoring-files";
import type {AuthoringRuntime, CompiledAuthoringInfo} from "./authoring-contract";
import {compiledArtifact} from "./compiled-artifact";
import {compareSchemas} from "./compare-schema";
import {executeMigration, type MigrationExecutionContext} from "./execute-migration";
import {inspectSchema} from "./inspect-schema";
import {bootstrapJournal, installBaseline} from "./journal";
import {resolveMigrationExecutionContext} from "./migration-plan-runtime";
import type {PgSchemaInfo, PgSession, ResolvedSqlResource} from "./pg-schema";
import {executeMigrationPath} from "./runner";
import {executePreparedSqlResource, prepareManualSqlResource} from "./sql-resource";
import {buildReleaseOnScratch, type ReleaseVerificationInput, type ScratchProvider} from "./verify";

export type PostgresAuthoringOptions = {
    source: ReleaseVerificationInput;
    target: ReleaseVerificationInput;
    history: {baseline: ReleaseVerificationInput; path: MigrationPathInfo; resolveContext: Parameters<typeof executeMigrationPath>[2]};
    scratch: ScratchProvider;
    files: AuthoringFiles;
    data: NonNullable<AuthoringRuntime["loadDataContext"]>;
    /** Representative source data belongs only in owned scratch, never in the desired clean create. */
    fixture(session: PgSession): Promise<ValidationResult<true>>;
};

function fail(reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.authoringInvalid", "blocking", {reason})]};
}

export function createPostgresAuthoringRuntime(options: PostgresAuthoringOptions): AuthoringRuntime {
    const {source, target, files, scratch} = options;
    const journal = {schema: "sd_authoring_journal"};
    const scope = {systemId: source.ref.systemId, schemas: source.inspection.schemas};
    const clean = new Map<string, PgSchemaInfo>();

    async function owned<T>(body: (session: PgSession, id: string) => Promise<ValidationResult<T>>): Promise<ValidationResult<T>> {
        const created = await scratch.create("upgrade-source");
        if (!created.ok) return created;
        if (!scratch.owns(created.value)) return fail("Authoring scratch ownership could not be proven");
        let result: ValidationResult<T>;
        try { result = await body(created.value.session, created.value.id); }
        catch (error) { result = fail(error instanceof Error ? error.message : String(error)); }
        const cleanup = await scratch.destroy(created.value);
        if (!cleanup.ok) return result.ok ? cleanup : {ok: false, problems: [...result.problems, ...cleanup.problems]};
        return result;
    }

    async function inspect(session: PgSession, release: ReleaseVerificationInput): Promise<ValidationResult<PgSchemaInfo>> {
        const result = await inspectSchema(session, release.inspection);
        if (!result.ok) return result;
        if (result.value.unknown.length > 0) return fail("Unsupported objects remain in authoring scratch");
        return {ok: true, value: result.value.schema};
    }

    async function desired(release: ReleaseVerificationInput): Promise<ValidationResult<PgSchemaInfo>> {
        const cached = clean.get(release.ref.releaseHash);
        if (cached !== undefined) return {ok: true, value: cached};
        const result = await owned(async session => {
            const built = await buildReleaseOnScratch(session, release);
            if (!built.ok) return built;
            return inspect(session, release);
        });
        if (result.ok) clean.set(release.ref.releaseHash, result.value);
        return result;
    }

    async function history(session: PgSession, id: string): Promise<ValidationResult<PgSchemaInfo>> {
        if (!sameReleaseRef(options.history.path.from, options.history.baseline.ref)
            || !sameReleaseRef(options.history.path.to, source.ref)) return fail("Historical path does not reach the source release");
        const built = await buildReleaseOnScratch(session, options.history.baseline);
        if (!built.ok) return built;
        const bootstrapped = await bootstrapJournal(session, journal);
        if (!bootstrapped.ok) return bootstrapped;
        const baseline = await installBaseline(session, journal, {installationId: id, scope, baseline: options.history.baseline.ref});
        if (!baseline.ok) return baseline;
        const replayed = await executeMigrationPath(session, options.history.path, async published => {
            const context = await options.history.resolveContext(published);
            return context.ok ? {ok: true, value: {...context.value, journal, scope}} : context;
        });
        if (!replayed.ok) return replayed;
        const observed = await inspect(session, source);
        if (!observed.ok) return observed;
        const expected = await desired(source);
        if (!expected.ok) return expected;
        const equal = compareSchemas(expected.value, {schema: observed.value, unknown: [], excluded: []});
        if (!equal.ok) return equal;
        if (!equal.value.equal) return fail("Migration history differs from its confirmed source SSOT");
        return observed;
    }

    async function resource(ref: {name: string; kind: string; contentHash: string}): Promise<ValidationResult<string>> {
        const found = files.resources.get(ref.name);
        if (found === undefined || found.ref.kind !== ref.kind || found.ref.contentHash !== ref.contentHash
            || createHash("sha256").update(found.text, "utf8").digest("hex") !== ref.contentHash) return fail("Missing or mismatched authored resource: " + ref.name);
        return {ok: true, value: found.text};
    }

    return {
        async loadRelease(ref) {
            const release = sameReleaseRef(ref, source.ref) ? source : sameReleaseRef(ref, target.ref) ? target : null;
            if (release === null) return fail("Unknown authoring release");
            const schema = await desired(release);
            return schema.ok ? {ok: true, value: {ref, expectedSchema: schema.value}} : schema;
        },
        async reconstructHistory(ref) {
            if (!sameReleaseRef(ref, source.ref)) return fail("Unknown historical head");
            return owned(history);
        },
        readQuery: resource, readSql: resource,
        emitResource: files.emitResource.bind(files), loadDataContext: options.data,
        async inspectDraft(draft) {
            const bindings = [
                [source.snapshot, draft.base.fromSnapshotHash], [target.snapshot, draft.base.toSnapshotHash],
                [source.persistence, draft.base.fromPersistenceHash], [target.persistence, draft.base.toPersistenceHash],
            ] as const;
            for (const [value, expected] of bindings) {
                const json = toJsonValue(value);
                if (!json.ok) return json;
                if (createHash("sha256").update(canonicalJson(json.value), "utf8").digest("hex") !== expected) return fail("Draft snapshot or persistence binding is stale");
            }
            return owned(async (session, id) => {
                const sourceState = await history(session, id);
                if (!sourceState.ok) return sourceState;
                const seeded = await options.fixture(session);
                if (!seeded.ok) return seeded;
                await session.query("BEGIN", []);
                try {
                    for (const step of draft.manual) {
                        const text = await resource(step.run);
                        if (!text.ok) return text;
                        const prepared = prepareManualSqlResource({ref: step.run, text: text.value});
                        if (!prepared.ok) return prepared;
                        const executed = await executePreparedSqlResource(session, prepared.value);
                        if (!executed.ok) return executed;
                    }
                    return await inspect(session, target);
                } finally { await session.query("ROLLBACK", []); }
            });
        },
        async inspectCompiled(compiled: CompiledAuthoringInfo) {
            return owned(async (session, id) => {
                const from = await history(session, id);
                if (!from.ok) return from;
                const to = await desired(target);
                if (!to.ok) return to;
                const seeded = await options.fixture(session);
                if (!seeded.ok) return seeded;
                const resources: Record<string, ResolvedSqlResource> = {};
                for (const [name, resource] of files.resources) {
                    if (resource.ref.kind !== "query") resources[name] = {ref: {...resource.ref, kind: resource.ref.kind}, text: resource.text};
                }
                const base: Omit<MigrationExecutionContext, "authoring"> = {
                    journal, scope, resources,
                    from: {expectedSchema: from.value, inspection: source.inspection, managedData: source.storage.managedData, invariantChecks: source.storage.invariantChecks},
                    to: {expectedSchema: to.value, inspection: target.inspection, managedData: target.storage.managedData, invariantChecks: target.storage.invariantChecks},
                    options: {statementTimeoutMs: 30_000, lockTimeoutMs: 5_000}, now: () => new Date().toISOString(),
                };
                const artifact = compiledArtifact(compiled, files, {from: source.snapshot, to: target.snapshot});
                const context = await resolveMigrationExecutionContext(artifact.published, base, artifact.runtime);
                if (!context.ok) return context;
                const executed = await executeMigration(session, artifact.published, context.value);
                if (!executed.ok) return executed;
                return inspect(session, target);
            });
        },
    };
}

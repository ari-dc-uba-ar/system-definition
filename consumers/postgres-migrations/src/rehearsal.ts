import {
    decodeMigrationPathInfo,
    decodeReleaseRefInfo,
    hasExactKeys,
    isNonEmptyString,
    isPlainObject,
    problem,
    sameReleaseRef,
    type MigrationPathInfo,
    type PublishedMigrationInfo,
    type ReleaseRefInfo,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {MigrationExecutionContext} from "./execute-migration";
import {
    readInstallation,
    type InstallationScope,
    type JournalConfig,
} from "./journal";
import type {PgSession} from "./pg-schema";
import {executeMigrationPath} from "./runner";
import {
    decodeRehearsalCopyRef,
    sameRehearsalCopyRef,
    type RehearsalCopyRef,
} from "./rehearsal-copy";

export type {RehearsalCopyRef} from "./rehearsal-copy";

export type RehearsalHandle = {
    copy: RehearsalCopyRef;
    session: PgSession;
};

export type RehearsalProvider = {
    open(copy: RehearsalCopyRef): Promise<ValidationResult<RehearsalHandle>>;
    owns(handle: RehearsalHandle): boolean;
    destroy(handle: RehearsalHandle): Promise<ValidationResult<true>>;
};

export type RehearsalArtifactInfo = {
    kind: "release" | "migration" | "resource";
    id: string;
    contentHash: string;
};

export type RehearsalCheckInfo = {
    id: string;
    contentHash: string;
};

export type RehearsalReportInfo = {
    copy: RehearsalCopyRef;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    scope: InstallationScope;
    migrations: readonly {id: string; migrationHash: string}[];
    artifacts: readonly RehearsalArtifactInfo[];
    checks: readonly RehearsalCheckInfo[];
    targetChecksRequired: true;
};

export type RehearsalInput = {
    copy: RehearsalCopyRef;
    path: MigrationPathInfo;
    journal: JournalConfig;
    scope: InstallationScope;
    resolveContext(migration: PublishedMigrationInfo):
        | MigrationExecutionContext
        | ValidationResult<MigrationExecutionContext>
        | Promise<MigrationExecutionContext | ValidationResult<MigrationExecutionContext>>;
};

export type RehearsalRequirement = {
    production: boolean;
    operation: "install" | "upgrade";
    from: ReleaseRefInfo | null;
    to: ReleaseRefInfo;
    scope: InstallationScope;
    path: MigrationPathInfo | null;
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function hasExactShape(
    value: unknown,
    expected: readonly string[],
): value is Readonly<Record<string, unknown>> {
    return isPlainObject(value) && hasExactKeys(value, expected);
}

function validRelease(value: unknown): value is ReleaseRefInfo {
    return decodeReleaseRefInfo(
        value,
        "$",
        () => fail<never>("migration.invalidReference", {reason: "invalid release reference"}),
    ).ok;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validSchemas(value: unknown): value is readonly string[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every(isNonEmptyString)
        && new Set(value).size === value.length;
}

function sameScope(left: InstallationScope, right: InstallationScope): boolean {
    return left.systemId === right.systemId && sameStrings(left.schemas, right.schemas);
}

function validCopy(value: unknown): value is RehearsalCopyRef {
    return decodeRehearsalCopyRef(
        value,
        "$",
        () => fail("migration.invalidReference", {reason: "invalid rehearsal copy reference"}) as ValidationResult<never>,
    ).ok;
}

function validScope(value: unknown): value is InstallationScope {
    return hasExactShape(value, ["systemId", "schemas"])
        && isNonEmptyString(value.systemId)
        && validSchemas(value.schemas);
}

function validJournal(value: unknown): value is JournalConfig {
    return hasExactShape(value, ["schema"])
        && isNonEmptyString(value.schema);
}

function validSession(value: unknown): value is PgSession {
    return typeof value === "object"
        && value !== null
        && typeof Reflect.get(value, "query") === "function"
        && typeof Reflect.get(value, "close") === "function";
}

function validHandle(value: unknown): value is RehearsalHandle {
    return hasExactShape(value, ["copy", "session"])
        && validCopy(value.copy)
        && validSession(value.session);
}

function validProvider(value: unknown): value is RehearsalProvider {
    return typeof value === "object"
        && value !== null
        && typeof Reflect.get(value, "open") === "function"
        && typeof Reflect.get(value, "owns") === "function"
        && typeof Reflect.get(value, "destroy") === "function";
}

function validPath(value: unknown): value is MigrationPathInfo {
    return decodeMigrationPathInfo(
        value,
        "$",
        () => fail<never>("migration.invalidReference", {reason: "invalid migration path"}),
    ).ok;
}

function validInput(value: unknown): value is RehearsalInput {
    return hasExactShape(value, ["copy", "path", "journal", "scope", "resolveContext"])
        && validCopy(value.copy)
        && validPath(value.path)
        && validJournal(value.journal)
        && validScope(value.scope)
        && typeof value.resolveContext === "function";
}

function isValidationResult<T>(value: unknown): value is ValidationResult<T> {
    return typeof value === "object"
        && value !== null
        && typeof Reflect.get(value, "ok") === "boolean";
}

function resourceKey(ref: ResourceRefInfo): string {
    return ref.kind + "\u0000" + ref.name + "\u0000" + ref.contentHash;
}

function pushResourceArtifact(
    artifacts: RehearsalArtifactInfo[],
    seen: Set<string>,
    ref: ResourceRefInfo,
): void {
    const key = resourceKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push({kind: "resource", id: ref.name, contentHash: ref.contentHash});
}

function buildReport(
    input: RehearsalInput,
    contexts: readonly {migration: PublishedMigrationInfo; context: MigrationExecutionContext}[],
): RehearsalReportInfo {
    const artifacts: RehearsalArtifactInfo[] = [];
    const seenReleases = new Set<string>();
    const addRelease = (release: ReleaseRefInfo): void => {
        const key = release.systemId + "\u0000" + release.releaseId + "\u0000" + release.releaseHash;
        if (seenReleases.has(key)) return;
        seenReleases.add(key);
        artifacts.push({kind: "release", id: release.releaseId, contentHash: release.releaseHash});
    };
    addRelease(input.path.from);
    for (const published of input.path.migrations) addRelease(published.migration.to);

    for (const published of input.path.migrations) {
        artifacts.push({
            kind: "migration",
            id: published.migration.id,
            contentHash: published.migrationHash,
        });
    }

    const seenResources = new Set<string>();
    const checks: RehearsalCheckInfo[] = [];
    for (const {migration, context} of contexts) {
        for (const ref of migration.migration.before) {
            pushResourceArtifact(artifacts, seenResources, ref);
            checks.push({id: ref.name, contentHash: ref.contentHash});
        }
        for (const step of migration.migration.steps) {
            pushResourceArtifact(artifacts, seenResources, step.run);
        }
        for (const ref of migration.migration.after) {
            pushResourceArtifact(artifacts, seenResources, ref);
            checks.push({id: ref.name, contentHash: ref.contentHash});
        }
        for (const ref of context.to.invariantChecks) {
            pushResourceArtifact(artifacts, seenResources, ref);
            checks.push({id: ref.name, contentHash: ref.contentHash});
        }
    }

    return {
        copy: {
            copyId: input.copy.copyId,
            provenance: input.copy.provenance,
            installationId: input.copy.installationId,
            source: {...input.copy.source},
            schemas: [...input.copy.schemas],
        },
        from: {...input.path.from},
        to: {...input.path.to},
        scope: {systemId: input.scope.systemId, schemas: [...input.scope.schemas]},
        migrations: input.path.migrations.map(one => ({
            id: one.migration.id,
            migrationHash: one.migrationHash,
        })),
        artifacts,
        checks,
        targetChecksRequired: true,
    };
}

async function destroyOwned(
    provider: RehearsalProvider,
    handle: RehearsalHandle,
): Promise<ValidationResult<true>> {
    try {
        return await provider.destroy(handle);
    } catch (error) {
        return fail("migration.executionFailed", {
            copyId: handle.copy.copyId,
            reason: error instanceof Error ? error.message : "rehearsal cleanup failed",
        });
    }
}

async function withOwnedHandle<T>(
    provider: RehearsalProvider,
    copy: RehearsalCopyRef,
    work: (handle: RehearsalHandle) => Promise<ValidationResult<T>>,
): Promise<ValidationResult<T>> {
    let opened: ValidationResult<RehearsalHandle>;
    try {
        opened = await provider.open(copy);
    } catch (error) {
        return fail("migration.executionFailed", {
            copyId: copy.copyId,
            reason: error instanceof Error ? error.message : "rehearsal copy could not be opened",
        });
    }
    if (!opened.ok) return opened;
    if (!validHandle(opened.value)) {
        return fail("migration.invalidReference", {reason: "rehearsal provider returned an invalid handle"});
    }

    let owned = false;
    try {
        owned = provider.owns(opened.value);
    } catch {
        owned = false;
    }
    if (!owned) {
        return fail("migration.invalidReference", {
            copyId: copy.copyId,
            reason: "rehearsal provider cannot prove ownership of the opened handle",
        });
    }

    let result: ValidationResult<T>;
    if (!sameRehearsalCopyRef(opened.value.copy, copy)) {
        result = fail("deployment.evidenceMismatch", {
            copyId: copy.copyId,
            reason: "opened copy identity does not match the requested copy",
        });
    } else {
        try {
            result = await work(opened.value);
        } catch (error) {
            result = fail("migration.executionFailed", {
                copyId: copy.copyId,
                reason: error instanceof Error ? error.message : "rehearsal execution failed",
            });
        }
    }

    const cleaned = await destroyOwned(provider, opened.value);
    if (cleaned.ok) return result;
    if (result.ok) return cleaned as ValidationResult<T>;
    return {ok: false, problems: [...result.problems, ...cleaned.problems]};
}

function contextMatchesRehearsal(
    context: MigrationExecutionContext,
    input: RehearsalInput,
): boolean {
    return context.journal.schema === input.journal.schema
        && sameScope(context.scope, input.scope);
}

export async function rehearseUpgrade(
    input: RehearsalInput,
    provider: RehearsalProvider,
): Promise<ValidationResult<RehearsalReportInfo>> {
    if (!validInput(input) || !validProvider(provider)) {
        return fail("migration.invalidReference", {reason: "invalid rehearsal input or provider"});
    }
    if (!sameReleaseRef(input.copy.source, input.path.from)
        || input.copy.source.systemId !== input.scope.systemId
        || !sameStrings(input.copy.schemas, input.scope.schemas)) {
        return fail("deployment.evidenceMismatch", {
            copyId: input.copy.copyId,
            reason: "declared copy source/scope does not match the rehearsal segment",
        });
    }

    return withOwnedHandle(provider, input.copy, async handle => {
        const installation = await readInstallation(handle.session, input.journal, input.scope);
        if (!installation.ok) return installation;
        if (installation.value === null
            || installation.value.installationId !== input.copy.installationId
            || !sameReleaseRef(installation.value.current, input.copy.source)) {
            return fail("deployment.evidenceMismatch", {
                copyId: input.copy.copyId,
                reason: "durable copy head does not match the declared source",
            });
        }

        const contexts: {migration: PublishedMigrationInfo; context: MigrationExecutionContext}[] = [];
        const executed = await executeMigrationPath(handle.session, input.path, async migration => {
            let resolved: MigrationExecutionContext | ValidationResult<MigrationExecutionContext>;
            try {
                resolved = await input.resolveContext(migration);
            } catch (error) {
                return fail<MigrationExecutionContext>("migration.executionFailed", {
                    migrationId: migration.migration.id,
                    reason: error instanceof Error ? error.message : "rehearsal context resolution failed",
                });
            }
            const normalized: ValidationResult<MigrationExecutionContext> = isValidationResult<MigrationExecutionContext>(resolved)
                ? resolved
                : {ok: true, value: resolved};
            if (!normalized.ok) return normalized;
            if (!contextMatchesRehearsal(normalized.value, input)) {
                return fail<MigrationExecutionContext>("deployment.evidenceMismatch", {
                    migrationId: migration.migration.id,
                    reason: "migration execution context does not match rehearsal journal/scope",
                });
            }
            contexts.push({migration, context: normalized.value});
            return normalized;
        });
        if (!executed.ok) return executed;
        if (!sameReleaseRef(executed.value.from, input.copy.source) || !sameReleaseRef(executed.value.to, input.path.to)) {
            return fail("deployment.evidenceMismatch", {
                copyId: input.copy.copyId,
                reason: "executed segment does not match rehearsal declaration",
            });
        }
        return {ok: true, value: buildReport(input, contexts)};
    });
}

function validRequirement(value: unknown): value is RehearsalRequirement {
    if (!hasExactShape(value, ["production", "operation", "from", "to", "scope", "path"])
        || typeof value.production !== "boolean"
        || (value.operation !== "install" && value.operation !== "upgrade")
        || !validRelease(value.to)
        || !validScope(value.scope)) {
        return false;
    }
    if (value.operation === "install") return value.from === null && value.path === null;
    return validRelease(value.from) && validPath(value.path);
}

function migrationListMatches(report: RehearsalReportInfo, path: MigrationPathInfo): boolean {
    return report.migrations.length === path.migrations.length
        && report.migrations.every((one, index) => {
            const expected = path.migrations[index];
            return expected !== undefined
                && one.id === expected.migration.id
                && one.migrationHash === expected.migrationHash;
        });
}

function artifactMatches(
    report: RehearsalReportInfo,
    kind: RehearsalArtifactInfo["kind"],
    id: string,
    contentHash: string,
): boolean {
    return report.artifacts.some(one => one.kind === kind && one.id === id && one.contentHash === contentHash);
}

function reportCoversPath(report: RehearsalReportInfo, path: MigrationPathInfo): boolean {
    if (!artifactMatches(report, "release", path.from.releaseId, path.from.releaseHash)
        || !artifactMatches(report, "release", path.to.releaseId, path.to.releaseHash)) {
        return false;
    }
    for (const migration of path.migrations) {
        if (!artifactMatches(report, "migration", migration.migration.id, migration.migrationHash)
            || !artifactMatches(report, "release", migration.migration.to.releaseId, migration.migration.to.releaseHash)) {
            return false;
        }
        for (const ref of migration.migration.before) {
            if (!artifactMatches(report, "resource", ref.name, ref.contentHash)
                || !report.checks.some(one => one.id === ref.name && one.contentHash === ref.contentHash)) {
                return false;
            }
        }
        for (const step of migration.migration.steps) {
            if (!artifactMatches(report, "resource", step.run.name, step.run.contentHash)) return false;
        }
        for (const ref of migration.migration.after) {
            if (!artifactMatches(report, "resource", ref.name, ref.contentHash)
                || !report.checks.some(one => one.id === ref.name && one.contentHash === ref.contentHash)) {
                return false;
            }
        }
    }
    return true;
}

function reportMatchesRequirement(report: RehearsalReportInfo, requirement: RehearsalRequirement): boolean {
    if (requirement.operation !== "upgrade" || requirement.from === null || requirement.path === null) return false;
    return sameReleaseRef(report.from, requirement.from)
        && sameReleaseRef(report.to, requirement.to)
        && sameReleaseRef(report.copy.source, requirement.from)
        && sameScope(report.scope, requirement.scope)
        && sameStrings(report.copy.schemas, requirement.scope.schemas)
        && report.targetChecksRequired === true
        && migrationListMatches(report, requirement.path)
        && reportCoversPath(report, requirement.path);
}

export function checkRehearsalRequirement(
    requirement: RehearsalRequirement,
    rehearsal: ValidationResult<RehearsalReportInfo> | null,
): ValidationResult<RehearsalReportInfo | null> {
    if (!validRequirement(requirement)) {
        return fail("deployment.evidenceMismatch", {reason: "invalid rehearsal requirement"});
    }
    if (requirement.operation === "install") {
        return {ok: true, value: null};
    }
    if (requirement.from === null || requirement.path === null
        || !sameReleaseRef(requirement.path.from, requirement.from)
        || !sameReleaseRef(requirement.path.to, requirement.to)
        || requirement.scope.systemId !== requirement.from.systemId) {
        return fail("deployment.evidenceMismatch", {reason: "upgrade requirement references do not agree"});
    }
    if (!requirement.production) {
        return rehearsal !== null && rehearsal.ok && reportMatchesRequirement(rehearsal.value, requirement)
            ? {ok: true, value: rehearsal.value}
            : {ok: true, value: null};
    }
    if (rehearsal === null) {
        return fail("deployment.verificationIncomplete", {reason: "production upgrade requires identified-copy rehearsal"});
    }
    if (!rehearsal.ok) {
        return fail("deployment.verificationFailed", {reason: "identified-copy rehearsal did not pass"});
    }
    if (!reportMatchesRequirement(rehearsal.value, requirement)) {
        return fail("deployment.evidenceMismatch", {reason: "rehearsal report does not match required source/target/path/scope"});
    }
    return {ok: true, value: rehearsal.value};
}

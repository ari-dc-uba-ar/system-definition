import {JsonValue, toJsonValue} from "./json-value";
import {decodeReleaseRefInfo, decodeResourceRefInfo, sameReleaseRef, type MigrationInfo, type ReleaseRefInfo, type ResourceRefInfo} from "./migration";
import {ValidationResult, problem} from "./problem";
import {childPath, exactKeys, isNonBlankString, isPlainObject, isSha256, type StructuralFailure} from "./decode-structure";

export type PublishedMigrationInfo = {
    migration: MigrationInfo;
    migrationHash: string;
};

export type MigrationCatalogInfo = {
    systemId: string;
    releases: readonly ReleaseRefInfo[];
    migrations: readonly PublishedMigrationInfo[];
};

export type MigrationPathInfo = {
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    migrations: readonly PublishedMigrationInfo[];
};

export type MigrationPlanInfo = {
    formatVersion: 1;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    migrations: readonly PublishedMigrationInfo[];
    planHash: string;
};

type JsonObject = {readonly [key: string]: JsonValue};

function invalidCatalog(path: string, reason: string): ValidationResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidCatalog", "blocking", {path, reason})],
    };
}

function invalidReference(path: string, reason: string): ValidationResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidReference", "blocking", {path, reason})],
    };
}

function downgradeUnsupported(fromId: string, toId: string): ValidationResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.downgradeUnsupported", "blocking", {fromId, toId})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}

function nonEmptyString(value: JsonValue, path: string, label: string, invalid: StructuralFailure = invalidCatalog): ValidationResult<string> {
    if (!isNonBlankString(value)) {
        return invalid(path, label + " must be a non-empty string");
    }
    return {ok: true, value};
}

function sha256(value: JsonValue, path: string, label: string, invalid: StructuralFailure = invalidCatalog): ValidationResult<string> {
    if (!isSha256(value)) {
        return invalid(path, label + " must be a lowercase SHA-256 hex digest");
    }
    return {ok: true, value};
}

function releaseRef(value: JsonValue, path: string, invalid: StructuralFailure = invalidCatalog): ValidationResult<ReleaseRefInfo> {
    return decodeReleaseRefInfo(value, path, invalid);
}

function resourceRef(value: JsonValue, path: string, expectedKind?: ResourceRefInfo["kind"], invalid: StructuralFailure = invalidCatalog): ValidationResult<ResourceRefInfo> {
    const decoded = decodeResourceRefInfo(value, path, invalid);
    if (!decoded.ok) return decoded;
    if (expectedKind !== undefined && decoded.value.kind !== expectedKind) {
        return invalid(childPath(path, "kind"), "resource kind does not match position");
    }
    return decoded;
}

function resourceRefs(value: JsonValue, path: string, expectedKind: ResourceRefInfo["kind"], invalid: StructuralFailure = invalidCatalog): ValidationResult<readonly ResourceRefInfo[]> {
    if (!Array.isArray(value)) return invalid(path, "expected an array");
    const result: ResourceRefInfo[] = [];
    for (let index = 0; index < value.length; index++) {
        const decoded = resourceRef(value[index], path + "[" + index + "]", expectedKind, invalid);
        if (!decoded.ok) return decoded;
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

function migrationInfo(value: JsonValue, path: string, invalid: StructuralFailure = invalidCatalog): ValidationResult<MigrationInfo> {
    if (!isObject(value)) return invalid(path, "expected a migration object");
    const shape = exactKeys(value, ["id", "from", "to", "description", "before", "steps", "after"], path, invalid);
    if (!shape.ok) return shape;
    const id = nonEmptyString(value.id, childPath(path, "id"), "migration id", invalid);
    if (!id.ok) return id;
    const from = releaseRef(value.from, childPath(path, "from"), invalid);
    if (!from.ok) return from;
    const to = releaseRef(value.to, childPath(path, "to"), invalid);
    if (!to.ok) return to;
    if (typeof value.description !== "string") return invalid(childPath(path, "description"), "expected a string");
    const before = resourceRefs(value.before, childPath(path, "before"), "check", invalid);
    if (!before.ok) return before;
    const after = resourceRefs(value.after, childPath(path, "after"), "check", invalid);
    if (!after.ok) return after;
    if (!Array.isArray(value.steps)) return invalid(childPath(path, "steps"), "expected an array");
    const steps: {id: string, run: ResourceRefInfo}[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < value.steps.length; index++) {
        const stepPath = path + '["steps"][' + index + "]";
        const rawStep = value.steps[index];
        if (!isObject(rawStep)) return invalid(stepPath, "expected a step object");
        const stepShape = exactKeys(rawStep, ["id", "run"], stepPath, invalid);
        if (!stepShape.ok) return stepShape;
        const stepId = nonEmptyString(rawStep.id, childPath(stepPath, "id"), "step id", invalid);
        if (!stepId.ok) return stepId;
        if (ids.has(stepId.value)) return invalid(childPath(stepPath, "id"), "step ids must not repeat");
        ids.add(stepId.value);
        const run = resourceRef(rawStep.run, childPath(stepPath, "run"), "sql", invalid);
        if (!run.ok) return run;
        steps.push({id: stepId.value, run: run.value});
    }
    return {
        ok: true,
        value: {
            id: id.value,
            from: from.value,
            to: to.value,
            description: value.description,
            before: before.value,
            steps,
            after: after.value,
        },
    };
}

function publishedMigration(value: JsonValue, path: string, invalid: StructuralFailure = invalidCatalog): ValidationResult<PublishedMigrationInfo> {
    if (!isObject(value)) return invalid(path, "expected a published migration");
    const shape = exactKeys(value, ["migration", "migrationHash"], path, invalid);
    if (!shape.ok) return shape;
    const migration = migrationInfo(value.migration, childPath(path, "migration"), invalid);
    if (!migration.ok) return migration;
    const migrationHash = sha256(value.migrationHash, childPath(path, "migrationHash"), "migrationHash", invalid);
    if (!migrationHash.ok) return migrationHash;
    return {ok: true, value: {migration: migration.value, migrationHash: migrationHash.value}};
}

export function decodePublishedMigrationInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<PublishedMigrationInfo> {
    const converted = toJsonValue(value);
    if (!converted.ok) return invalid(path, "published migration must be strict JSON");
    return publishedMigration(converted.value, path, invalid);
}

export function decodeMigrationPathInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<MigrationPathInfo> {
    const converted = toJsonValue(value);
    if (!converted.ok || !isObject(converted.value)) return invalid(path, "expected a migration path");
    const raw = converted.value;
    const shape = exactKeys(raw, ["from", "to", "migrations"], path, invalid);
    if (!shape.ok) return shape;
    const from = releaseRef(raw.from, childPath(path, "from"), invalid);
    if (!from.ok) return from;
    const to = releaseRef(raw.to, childPath(path, "to"), invalid);
    if (!to.ok) return to;
    if (!Array.isArray(raw.migrations)) return invalid(childPath(path, "migrations"), "expected an array");
    const migrations: PublishedMigrationInfo[] = [];
    let expected = from.value;
    for (let index = 0; index < raw.migrations.length; index++) {
        const itemPath = childPath(path, "migrations") + "[" + index + "]";
        const decoded = publishedMigration(raw.migrations[index]!, itemPath, invalid);
        if (!decoded.ok) return decoded;
        if (!sameReleaseRef(decoded.value.migration.from, expected)) {
            return invalid(itemPath, "migration path is not contiguous");
        }
        expected = decoded.value.migration.to;
        migrations.push(decoded.value);
    }
    if (!sameReleaseRef(expected, to.value)) {
        return invalid(path, "migration path does not end at target");
    }
    return {ok: true, value: {from: from.value, to: to.value, migrations}};
}

export function completeMigrationCatalog(
    releases: readonly ReleaseRefInfo[],
    migrations: readonly PublishedMigrationInfo[],
): ValidationResult<MigrationCatalogInfo> {
    const copied = toJsonValue({releases, migrations});
    if (!copied.ok) return copied;
    if (!isObject(copied.value)) return invalidCatalog("$", "expected a catalog input object");
    if (!Array.isArray(copied.value.releases) || !Array.isArray(copied.value.migrations)) {
        return invalidCatalog("$", "releases and migrations must be arrays");
    }
    if (copied.value.releases.length === 0) return invalidCatalog('$["releases"]', "catalog must contain at least one release");

    const completedReleases: ReleaseRefInfo[] = [];
    const releaseIds = new Set<string>();
    let systemId: string | undefined;
    for (let index = 0; index < copied.value.releases.length; index++) {
        const decoded = releaseRef(copied.value.releases[index], '$["releases"][' + index + "]");
        if (!decoded.ok) return decoded;
        if (releaseIds.has(decoded.value.releaseId)) {
            return invalidCatalog('$["releases"][' + index + ']["releaseId"]', "release ids must not repeat");
        }
        releaseIds.add(decoded.value.releaseId);
        if (systemId === undefined) systemId = decoded.value.systemId;
        if (decoded.value.systemId !== systemId) {
            return invalidCatalog('$["releases"][' + index + ']["systemId"]', "all releases must belong to one system");
        }
        completedReleases.push(decoded.value);
    }

    if (copied.value.migrations.length !== Math.max(0, completedReleases.length - 1)) {
        return invalidCatalog('$["migrations"]', "migration count must connect every consecutive release");
    }

    const completedMigrations: PublishedMigrationInfo[] = [];
    const migrationIds = new Set<string>();
    for (let index = 0; index < copied.value.migrations.length; index++) {
        const decoded = publishedMigration(copied.value.migrations[index], '$["migrations"][' + index + "]");
        if (!decoded.ok) return decoded;
        const migration = decoded.value.migration;
        if (migrationIds.has(migration.id)) {
            return invalidCatalog('$["migrations"][' + index + ']["migration"]["id"]', "migration ids must not repeat");
        }
        migrationIds.add(migration.id);
        if (migration.from.systemId !== systemId || migration.to.systemId !== systemId) {
            return invalidCatalog('$["migrations"][' + index + ']["migration"]', "migration system must match catalog");
        }
        if (migration.from.releaseId === migration.to.releaseId) {
            return invalidCatalog('$["migrations"][' + index + ']["migration"]', "self edges are not allowed");
        }
        const expectedFrom = completedReleases[index];
        const expectedTo = completedReleases[index + 1];
        if (
            migration.from.releaseId !== expectedFrom.releaseId
            || migration.from.releaseHash !== expectedFrom.releaseHash
            || migration.from.systemId !== expectedFrom.systemId
            || migration.to.releaseId !== expectedTo.releaseId
            || migration.to.releaseHash !== expectedTo.releaseHash
            || migration.to.systemId !== expectedTo.systemId
        ) {
            return invalidCatalog('$["migrations"][' + index + ']["migration"]', "migration must connect the consecutive releases at the same position");
        }
        completedMigrations.push(decoded.value);
    }

    return {
        ok: true,
        value: {
            systemId: systemId as string,
            releases: completedReleases,
            migrations: completedMigrations,
        },
    };
}

export function resolveMigrationPath(
    catalog: MigrationCatalogInfo,
    fromId: string,
    toId: string,
): ValidationResult<MigrationPathInfo> {
    const fromIndex = catalog.releases.findIndex(release => release.releaseId === fromId);
    if (fromIndex < 0) return invalidReference("fromId", "unknown release " + JSON.stringify(fromId));
    const toIndex = catalog.releases.findIndex(release => release.releaseId === toId);
    if (toIndex < 0) return invalidReference("toId", "unknown release " + JSON.stringify(toId));
    if (toIndex < fromIndex) return downgradeUnsupported(fromId, toId);

    const from = catalog.releases[fromIndex];
    const to = catalog.releases[toIndex];
    return {
        ok: true,
        value: {
            from: {systemId: from.systemId, releaseId: from.releaseId, releaseHash: from.releaseHash},
            to: {systemId: to.systemId, releaseId: to.releaseId, releaseHash: to.releaseHash},
            migrations: catalog.migrations.slice(fromIndex, toIndex).map(one => ({
                migration: {
                    id: one.migration.id,
                    from: {...one.migration.from},
                    to: {...one.migration.to},
                    description: one.migration.description,
                    before: one.migration.before.map(ref => ({...ref})),
                    steps: one.migration.steps.map(step => ({id: step.id, run: {...step.run}})),
                    after: one.migration.after.map(ref => ({...ref})),
                },
                migrationHash: one.migrationHash,
            })),
        },
    };
}

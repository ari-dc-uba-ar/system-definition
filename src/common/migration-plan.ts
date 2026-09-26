import {JsonValue, toJsonValue} from "./json-value";
import type {MigrationInfo, ReleaseRefInfo, ResourceRefInfo} from "./migration";
import {ValidationResult, problem} from "./problem";

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
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): ValidationResult<true> {
    const expected = new Set(keys);
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) return invalidCatalog(path + "[" + JSON.stringify(key) + "]", "unexpected property");
    }
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return invalidCatalog(path + "[" + JSON.stringify(key) + "]", "missing property");
        }
    }
    return {ok: true, value: true};
}

function nonEmptyString(value: JsonValue, path: string, label: string): ValidationResult<string> {
    if (typeof value !== "string" || value.trim().length === 0) {
        return invalidCatalog(path, label + " must be a non-empty string");
    }
    return {ok: true, value};
}

function sha256(value: JsonValue, path: string, label: string): ValidationResult<string> {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
        return invalidCatalog(path, label + " must be a lowercase SHA-256 hex digest");
    }
    return {ok: true, value};
}

function releaseRef(value: JsonValue, path: string): ValidationResult<ReleaseRefInfo> {
    if (!isObject(value)) return invalidCatalog(path, "expected a release reference");
    const shape = exactKeys(value, ["systemId", "releaseId", "releaseHash"], path);
    if (!shape.ok) return shape;
    const systemId = nonEmptyString(value.systemId, path + '["systemId"]', "systemId");
    if (!systemId.ok) return systemId;
    const releaseId = nonEmptyString(value.releaseId, path + '["releaseId"]', "releaseId");
    if (!releaseId.ok) return releaseId;
    const releaseHash = sha256(value.releaseHash, path + '["releaseHash"]', "releaseHash");
    if (!releaseHash.ok) return releaseHash;
    return {ok: true, value: {systemId: systemId.value, releaseId: releaseId.value, releaseHash: releaseHash.value}};
}

function resourceRef(value: JsonValue, path: string, expectedKind?: ResourceRefInfo["kind"]): ValidationResult<ResourceRefInfo> {
    if (!isObject(value)) return invalidCatalog(path, "expected a resource reference");
    const shape = exactKeys(value, ["name", "kind", "contentHash"], path);
    if (!shape.ok) return shape;
    const name = nonEmptyString(value.name, path + '["name"]', "resource name");
    if (!name.ok) return name;
    if (value.kind !== "sql" && value.kind !== "check") {
        return invalidCatalog(path + '["kind"]', "unsupported resource kind");
    }
    if (expectedKind !== undefined && value.kind !== expectedKind) {
        return invalidCatalog(path + '["kind"]', "resource kind does not match position");
    }
    const contentHash = sha256(value.contentHash, path + '["contentHash"]', "resource contentHash");
    if (!contentHash.ok) return contentHash;
    return {ok: true, value: {name: name.value, kind: value.kind, contentHash: contentHash.value}};
}

function resourceRefs(value: JsonValue, path: string, expectedKind: ResourceRefInfo["kind"]): ValidationResult<readonly ResourceRefInfo[]> {
    if (!Array.isArray(value)) return invalidCatalog(path, "expected an array");
    const result: ResourceRefInfo[] = [];
    for (let index = 0; index < value.length; index++) {
        const decoded = resourceRef(value[index], path + "[" + index + "]", expectedKind);
        if (!decoded.ok) return decoded;
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

function migrationInfo(value: JsonValue, path: string): ValidationResult<MigrationInfo> {
    if (!isObject(value)) return invalidCatalog(path, "expected a migration object");
    const shape = exactKeys(value, ["id", "from", "to", "description", "before", "steps", "after"], path);
    if (!shape.ok) return shape;
    const id = nonEmptyString(value.id, path + '["id"]', "migration id");
    if (!id.ok) return id;
    const from = releaseRef(value.from, path + '["from"]');
    if (!from.ok) return from;
    const to = releaseRef(value.to, path + '["to"]');
    if (!to.ok) return to;
    if (typeof value.description !== "string") return invalidCatalog(path + '["description"]', "expected a string");
    const before = resourceRefs(value.before, path + '["before"]', "check");
    if (!before.ok) return before;
    const after = resourceRefs(value.after, path + '["after"]', "check");
    if (!after.ok) return after;
    if (!Array.isArray(value.steps)) return invalidCatalog(path + '["steps"]', "expected an array");
    const steps: {id: string, run: ResourceRefInfo}[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < value.steps.length; index++) {
        const stepPath = path + '["steps"][' + index + "]";
        const rawStep = value.steps[index];
        if (!isObject(rawStep)) return invalidCatalog(stepPath, "expected a step object");
        const stepShape = exactKeys(rawStep, ["id", "run"], stepPath);
        if (!stepShape.ok) return stepShape;
        const stepId = nonEmptyString(rawStep.id, stepPath + '["id"]', "step id");
        if (!stepId.ok) return stepId;
        if (ids.has(stepId.value)) return invalidCatalog(stepPath + '["id"]', "step ids must not repeat");
        ids.add(stepId.value);
        const run = resourceRef(rawStep.run, stepPath + '["run"]', "sql");
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

function publishedMigration(value: JsonValue, path: string): ValidationResult<PublishedMigrationInfo> {
    if (!isObject(value)) return invalidCatalog(path, "expected a published migration");
    const shape = exactKeys(value, ["migration", "migrationHash"], path);
    if (!shape.ok) return shape;
    const migration = migrationInfo(value.migration, path + '["migration"]');
    if (!migration.ok) return migration;
    const migrationHash = sha256(value.migrationHash, path + '["migrationHash"]', "migrationHash");
    if (!migrationHash.ok) return migrationHash;
    return {ok: true, value: {migration: migration.value, migrationHash: migrationHash.value}};
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

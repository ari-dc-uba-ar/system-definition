import {
    compareUtf16,
    problem,
    type ValidationResult,
} from "system-definition";
import type {InspectionInfo} from "./inspect-schema";
import {pgIdentityKey} from "./pg-identity";
import type {
    CreateResourceInfo,
    PgObjectIdentity,
    StorageContext,
} from "./pg-schema";

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}



function validIdentity(identity: PgObjectIdentity): boolean {
    return identity.schema.length > 0
        && identity.kind.length > 0
        && identity.name.length > 0
        && !identity.schema.includes("\0")
        && !identity.kind.includes("\0")
        && !identity.name.includes("\0")
        && (identity.parentName === null || (identity.parentName.length > 0 && !identity.parentName.includes("\0")))
        && identity.signature.every(one => one.length > 0 && !one.includes("\0"));
}

function sameResourceRef(
    expected: CreateResourceInfo["run"],
    actual: StorageContext["resources"][string]["ref"],
): boolean {
    return expected.name === actual.name
        && expected.kind === actual.kind
        && expected.contentHash === actual.contentHash;
}

export function prepareCreateResources(
    storage: StorageContext,
): ValidationResult<readonly CreateResourceInfo[]> {
    const byId = new Map<string, CreateResourceInfo>();
    const authoredObjects = new Set<string>();

    for (const resource of storage.createResources) {
        if (resource.id.length === 0 || resource.id.includes("\0")) {
            return fail("migration.unsupportedFormat", {reason: "create resource id must be a non-empty safe string"});
        }
        if (byId.has(resource.id)) {
            return fail("migration.invalidReference", {id: resource.id, reason: "duplicate create resource id"});
        }
        if (resource.run.kind !== "sql") {
            return fail("migration.invalidResourceKind", {name: resource.run.name, expected: "sql"});
        }
        const resolved = storage.resources[resource.run.name];
        if (resolved === undefined) {
            return fail("migration.invalidReference", {name: resource.run.name, reason: "create resource SQL is missing"});
        }
        if (!sameResourceRef(resource.run, resolved.ref)) {
            return fail("migration.checksumMismatch", {name: resource.run.name, reason: "create resource ref differs from resolved resource"});
        }
        if (new Set(resource.dependsOn).size !== resource.dependsOn.length) {
            return fail("migration.invalidReference", {id: resource.id, reason: "duplicate create resource dependency"});
        }
        for (const object of resource.expectedObjects) {
            if (!validIdentity(object)) {
                return fail("migration.unsupportedFormat", {id: resource.id, reason: "invalid expected object identity"});
            }
            const key = pgIdentityKey(object);
            if (authoredObjects.has(key)) {
                return fail("migration.invalidReference", {id: resource.id, object: key, reason: "expected object is authored more than once"});
            }
            authoredObjects.add(key);
        }
        byId.set(resource.id, resource);
    }

    for (const resource of storage.createResources) {
        for (const dependency of resource.dependsOn) {
            if (dependency === resource.id) {
                return fail("migration.invalidReference", {id: resource.id, reason: "create resource depends on itself"});
            }
            if (!byId.has(dependency)) {
                return fail("migration.invalidReference", {id: resource.id, dependency, reason: "unknown create resource dependency"});
            }
        }
    }

    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const resource of storage.createResources) {
        indegree.set(resource.id, resource.dependsOn.length);
        dependents.set(resource.id, []);
    }
    for (const resource of storage.createResources) {
        for (const dependency of resource.dependsOn) {
            dependents.get(dependency)?.push(resource.id);
        }
    }
    for (const values of dependents.values()) values.sort(compareUtf16);

    const ready = [...indegree.entries()]
        .filter(([, count]) => count === 0)
        .map(([id]) => id)
        .sort(compareUtf16);
    const ordered: CreateResourceInfo[] = [];

    while (ready.length > 0) {
        const id = ready.shift();
        if (id === undefined) break;
        const resource = byId.get(id);
        if (resource === undefined) continue;
        ordered.push({
            id: resource.id,
            run: {...resource.run},
            dependsOn: [...resource.dependsOn],
            expectedObjects: resource.expectedObjects.map(object => ({...object, signature: [...object.signature]})),
        });
        for (const dependent of dependents.get(id) ?? []) {
            const next = (indegree.get(dependent) ?? 0) - 1;
            indegree.set(dependent, next);
            if (next === 0) {
                ready.push(dependent);
                ready.sort(compareUtf16);
            }
        }
    }

    if (ordered.length !== storage.createResources.length) {
        return fail("migration.invalidReference", {reason: "create resource dependency graph contains a cycle"});
    }
    return {ok: true, value: ordered};
}

export function validateExpectedObjects(
    resources: readonly CreateResourceInfo[],
    inspection: InspectionInfo,
): ValidationResult<true> {
    if (inspection.unknown.length > 0) {
        const first = inspection.unknown[0];
        return fail("migration.unsupportedSchemaFeature", {
            feature: first?.feature ?? "unknown",
            object: first === undefined ? "unknown" : pgIdentityKey(first.object),
        });
    }

    const actual = new Map<string, string>();
    for (const object of inspection.schema.objects) {
        const key = pgIdentityKey(object.identity);
        if (actual.has(key)) {
            return fail("migration.unsupportedSchemaFeature", {object: key, reason: "duplicate inspected object identity"});
        }
        actual.set(key, object.kind);
    }

    const expected = new Set<string>();
    for (const resource of resources) {
        for (const object of resource.expectedObjects) {
            const key = pgIdentityKey(object);
            if (expected.has(key)) {
                return fail("migration.invalidReference", {id: resource.id, object: key, reason: "expected object is declared more than once"});
            }
            expected.add(key);
            const kind = actual.get(key);
            if (kind === undefined) {
                return fail("migration.unsupportedSchemaFeature", {id: resource.id, object: key, reason: "expected object is missing"});
            }
            if (kind !== object.kind) {
                return fail("migration.unsupportedSchemaFeature", {id: resource.id, object: key, reason: "expected object kind differs"});
            }
        }
    }
    return {ok: true, value: true};
}

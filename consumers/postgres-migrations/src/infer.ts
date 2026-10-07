import {createHash} from "node:crypto";
import {
    canonicalJson,
    compareUtf16,
    problem,
    toJsonValue,
    type JsonValue,
    type ValidationResult,
} from "system-definition";
import type {
    AuthoringBaseInfo,
    ChangeImpact,
    FieldRefInfo,
    RenameInfo,
    StructureChangeInfo,
    StructureDifferenceInfo,
} from "./authoring-contract";
import {pgIdentityKey} from "./pg-identity";
import type {PgObjectIdentity, PgObjectInfo, PgSchemaInfo} from "./pg-schema";

type ObjectMap = ReadonlyMap<string, PgObjectInfo>;

type Correspondence = {
    beforeKey: string;
    afterKey: string;
    authoredRename: boolean;
};

type ChangeWithoutId = Omit<StructureChangeInfo, "id">;

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}



function cloneIdentity(identity: PgObjectIdentity): PgObjectIdentity {
    return {
        schema: identity.schema,
        kind: identity.kind,
        name: identity.name,
        parentName: identity.parentName,
        signature: [...identity.signature],
    };
}

function objectMap(schema: PgSchemaInfo): ValidationResult<Map<string, PgObjectInfo>> {
    if (schema.formatVersion !== 1 || schema.engineVersion !== "18.6") {
        return fail("migration.unsupportedFormat", {reason: "schema format or PostgreSQL engine version mismatch"});
    }

    const result = new Map<string, PgObjectInfo>();
    for (const object of schema.objects) {
        if (object.kind !== object.identity.kind) {
            return fail("migration.unsupportedSchemaFeature", {
                object: pgIdentityKey(object.identity),
                reason: "object identity kind does not match its descriptor kind",
            });
        }
        const key = pgIdentityKey(object.identity);
        if (result.has(key)) {
            return fail("migration.unsupportedSchemaFeature", {
                object: key,
                reason: "duplicate schema object identity",
            });
        }
        result.set(key, object);
    }
    return {ok: true, value: result};
}

function isFieldRef(value: RenameInfo["before"]): value is FieldRefInfo {
    return Object.prototype.hasOwnProperty.call(value, "field");
}

function findUnique(
    objects: ObjectMap,
    predicate: (object: PgObjectInfo) => boolean,
    description: string,
): ValidationResult<PgObjectInfo> {
    const matches = [...objects.values()].filter(predicate);
    if (matches.length === 0) {
        return fail("migration.invalidReference", {reference: description, reason: "rename endpoint does not exist"});
    }
    if (matches.length !== 1) {
        return fail("migration.unsupportedSchemaFeature", {reference: description, reason: "rename endpoint is ambiguous"});
    }
    return {ok: true, value: matches[0] as PgObjectInfo};
}

function findField(objects: ObjectMap, ref: FieldRefInfo): ValidationResult<PgObjectInfo> {
    return findUnique(
        objects,
        object => object.kind === "column"
            && object.identity.parentName === ref.entity
            && object.identity.name === ref.field,
        `${ref.side}:${ref.entity}.${ref.field}`,
    );
}

function findEntity(objects: ObjectMap, entity: string, side: "from" | "to"): ValidationResult<PgObjectInfo> {
    return findUnique(
        objects,
        object => object.kind === "table" && object.identity.name === entity,
        `${side}:${entity}`,
    );
}

function addCorrespondence(
    result: Map<string, Correspondence>,
    destinations: Map<string, string>,
    beforeKey: string,
    afterKey: string,
    authoredRename: boolean,
): ValidationResult<true> {
    const existingAfter = destinations.get(afterKey);
    if ((result.has(beforeKey) && result.get(beforeKey)?.afterKey !== afterKey)
        || (existingAfter !== undefined && existingAfter !== beforeKey)) {
        return fail("migration.invalidReference", {reason: "rename correspondence must be bijective"});
    }
    if (result.has(beforeKey)) {
        return fail("migration.invalidReference", {reason: "duplicate rename correspondence"});
    }
    result.set(beforeKey, {beforeKey, afterKey, authoredRename});
    destinations.set(afterKey, beforeKey);
    return {ok: true, value: true};
}

function childIdentityAfterEntityRename(
    before: PgObjectIdentity,
    beforeTable: PgObjectIdentity,
    afterTable: PgObjectIdentity,
): PgObjectIdentity {
    return {
        schema: before.schema === beforeTable.schema ? afterTable.schema : before.schema,
        kind: before.kind,
        name: before.name,
        parentName: afterTable.name,
        signature: [...before.signature],
    };
}

function buildCorrespondences(
    from: ObjectMap,
    to: ObjectMap,
    renames: readonly RenameInfo[],
): ValidationResult<Map<string, Correspondence>> {
    const result = new Map<string, Correspondence>();
    const destinations = new Map<string, string>();

    for (const rename of renames) {
        const beforeIsField = isFieldRef(rename.before);
        const afterIsField = isFieldRef(rename.after);
        if (beforeIsField !== afterIsField) {
            return fail("migration.invalidReference", {reason: "rename endpoints must have the same scope"});
        }

        if (isFieldRef(rename.before) && isFieldRef(rename.after)) {
            if (rename.before.side !== "from" || rename.after.side !== "to") {
                return fail("migration.invalidReference", {reason: "field rename must map from-side to to-side"});
            }
            const before = findField(from, rename.before);
            if (!before.ok) return before;
            const after = findField(to, rename.after);
            if (!after.ok) return after;
            const added = addCorrespondence(
                result,
                destinations,
                pgIdentityKey(before.value.identity),
                pgIdentityKey(after.value.identity),
                true,
            );
            if (!added.ok) return added;
            continue;
        }

        const beforeEntity = rename.before.entity;
        const afterEntity = rename.after.entity;
        const beforeTable = findEntity(from, beforeEntity, "from");
        if (!beforeTable.ok) return beforeTable;
        const afterTable = findEntity(to, afterEntity, "to");
        if (!afterTable.ok) return afterTable;

        const beforeTableKey = pgIdentityKey(beforeTable.value.identity);
        const afterTableKey = pgIdentityKey(afterTable.value.identity);
        const tableAdded = addCorrespondence(result, destinations, beforeTableKey, afterTableKey, true);
        if (!tableAdded.ok) return tableAdded;

        for (const object of from.values()) {
            if (object.identity.parentName !== beforeEntity) continue;
            const expectedAfterIdentity = childIdentityAfterEntityRename(
                object.identity,
                beforeTable.value.identity,
                afterTable.value.identity,
            );
            const afterKey = pgIdentityKey(expectedAfterIdentity);
            if (!to.has(afterKey)) continue;
            const childAdded = addCorrespondence(
                result,
                destinations,
                pgIdentityKey(object.identity),
                afterKey,
                false,
            );
            if (!childAdded.ok) return childAdded;
        }
    }

    for (const correspondence of result.values()) {
        if (!from.has(correspondence.beforeKey) || !to.has(correspondence.afterKey)) {
            return fail("migration.invalidReference", {reason: "rename correspondence does not resolve on both sides"});
        }
        if (correspondence.beforeKey !== correspondence.afterKey && to.has(correspondence.beforeKey)) {
            return fail("migration.invalidReference", {
                reason: "rename source identity collides with an object retained by the target",
            });
        }
    }

    return {ok: true, value: result};
}

function asJson(value: unknown): JsonValue {
    const converted = toJsonValue(value);
    if (!converted.ok) throw new TypeError("validated PostgreSQL schema object is not strict JSON");
    return converted.value;
}

function plainRecord(value: JsonValue): value is {readonly [key: string]: JsonValue} {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAttributes(object: PgObjectInfo): JsonValue {
    const converted = asJson(object);
    if (!plainRecord(converted)) throw new TypeError("PostgreSQL schema object must be a JSON object");
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(converted)) {
        if (key !== "identity") result[key] = converted[key] as JsonValue;
    }
    return result;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => sameJson(value, right[index] as JsonValue));
    }
    if (plainRecord(left) && plainRecord(right)) {
        const leftKeys = Object.keys(left).sort(compareUtf16);
        const rightKeys = Object.keys(right).sort(compareUtf16);
        return leftKeys.length === rightKeys.length
            && leftKeys.every((key, index) => key === rightKeys[index]
                && sameJson(left[key] as JsonValue, right[key] as JsonValue));
    }
    return false;
}

function compareJson(
    before: JsonValue,
    after: JsonValue,
    path: readonly string[],
    differences: StructureDifferenceInfo[],
): void {
    if (sameJson(before, after)) return;
    if (plainRecord(before) && plainRecord(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareUtf16);
        for (const key of keys) {
            const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
            const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
            if (!hasBefore) {
                differences.push({path: [...path, key], before: null, after: after[key] as JsonValue});
            } else if (!hasAfter) {
                differences.push({path: [...path, key], before: before[key] as JsonValue, after: null});
            } else {
                compareJson(before[key] as JsonValue, after[key] as JsonValue, [...path, key], differences);
            }
        }
        return;
    }
    differences.push({path, before, after});
}

function objectDifferences(before: PgObjectInfo, after: PgObjectInfo): readonly StructureDifferenceInfo[] {
    const differences: StructureDifferenceInfo[] = [];
    compareJson(objectAttributes(before), objectAttributes(after), [], differences);
    return differences;
}

function isOnlyDifference(differences: readonly StructureDifferenceInfo[], path: readonly string[]): boolean {
    return differences.length === 1
        && differences[0]?.path.length === path.length
        && differences[0]?.path.every((piece, index) => piece === path[index]);
}

function differenceUnder(difference: StructureDifferenceInfo, first: string): boolean {
    return difference.path[0] === first;
}

function classifyAdd(object: PgObjectInfo): ChangeImpact {
    if (object.kind === "column") return object.nullable ? "preserving" : "requiresDataCheck";
    if (object.kind === "constraint") return "requiresDataCheck";
    return "preserving";
}

function classifyRemove(object: PgObjectInfo): ChangeImpact {
    if (object.kind === "table" || object.kind === "column") return "destructive";
    return "unsupported";
}

function classifyAlter(
    before: PgObjectInfo,
    after: PgObjectInfo,
    differences: readonly StructureDifferenceInfo[],
): ChangeImpact {
    if (before.kind !== after.kind) return "unsupported";
    if (before.kind === "column" && after.kind === "column") {
        if (isOnlyDifference(differences, ["nullable"])) {
            return before.nullable && !after.nullable ? "requiresDataCheck" : "preserving";
        }
        if (differences.some(one => differenceUnder(one, "type"))) return "requiresDataCheck";
        if (differences.every(one => one.path[0] === "nullable" || one.path[0] === "defaultExpression")) {
            return differences.some(one => one.path[0] === "nullable" && before.nullable && !after.nullable)
                ? "requiresDataCheck"
                : "preserving";
        }
        return "unsupported";
    }
    if (before.kind === "constraint" && after.kind === "constraint") return "requiresDataCheck";
    if ((before.kind === "view" && after.kind === "view")
        || (before.kind === "routine" && after.kind === "routine")) return "preserving";
    return "unsupported";
}

function fieldRef(side: "from" | "to", identity: PgObjectIdentity): FieldRefInfo | null {
    if (identity.kind !== "column" || identity.parentName === null) return null;
    return {side, entity: identity.parentName, field: identity.name};
}

function affectedFields(
    before: PgObjectInfo | null,
    after: PgObjectInfo | null,
    from: ObjectMap,
    to: ObjectMap,
): readonly FieldRefInfo[] {
    const result: FieldRefInfo[] = [];
    const seen = new Set<string>();
    const push = (field: FieldRefInfo): void => {
        const key = `${field.side}\0${field.entity}\0${field.field}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(field);
        }
    };

    if (before !== null) {
        const direct = fieldRef("from", before.identity);
        if (direct !== null) push(direct);
        if (before.kind === "table") {
            for (const object of from.values()) {
                if (object.kind === "column" && object.identity.parentName === before.identity.name) {
                    const ref = fieldRef("from", object.identity);
                    if (ref !== null) push(ref);
                }
            }
        }
    }
    if (after !== null) {
        const direct = fieldRef("to", after.identity);
        if (direct !== null) push(direct);
        if (after.kind === "table") {
            for (const object of to.values()) {
                if (object.kind === "column" && object.identity.parentName === after.identity.name) {
                    const ref = fieldRef("to", object.identity);
                    if (ref !== null) push(ref);
                }
            }
        }
    }

    result.sort((left, right) => compareUtf16(
        `${left.side}\0${left.entity}\0${left.field}`,
        `${right.side}\0${right.entity}\0${right.field}`,
    ));
    return result;
}

function changeSortKey(change: ChangeWithoutId): string {
    return canonicalJson(asJson({
        action: change.action,
        before: change.before,
        after: change.after,
        differences: change.differences,
    }));
}

function changeId(base: AuthoringBaseInfo, change: ChangeWithoutId): string {
    const json = asJson({
        base,
        action: change.action,
        before: change.before,
        after: change.after,
        differences: change.differences,
    });
    return createHash("sha256").update(canonicalJson(json), "utf8").digest("hex");
}

function makeChange(
    action: ChangeWithoutId["action"],
    origin: ChangeWithoutId["origin"],
    impact: ChangeImpact,
    before: PgObjectInfo | null,
    after: PgObjectInfo | null,
    differences: readonly StructureDifferenceInfo[],
    from: ObjectMap,
    to: ObjectMap,
): ChangeWithoutId {
    return {
        action,
        origin,
        impact,
        before: before === null ? null : cloneIdentity(before.identity),
        after: after === null ? null : cloneIdentity(after.identity),
        differences: differences.map(one => ({path: [...one.path], before: one.before, after: one.after})),
        affectedFields: affectedFields(before, after, from, to),
        dependsOn: [],
    };
}

export function inferStructureChanges(
    base: AuthoringBaseInfo,
    from: PgSchemaInfo,
    to: PgSchemaInfo,
    renames: readonly RenameInfo[],
): ValidationResult<readonly StructureChangeInfo[]> {
    const fromMap = objectMap(from);
    if (!fromMap.ok) return fromMap;
    const toMap = objectMap(to);
    if (!toMap.ok) return toMap;

    const correspondences = buildCorrespondences(fromMap.value, toMap.value, renames);
    if (!correspondences.ok) return correspondences;

    const pairedBefore = new Set<string>();
    const pairedAfter = new Set<string>();
    const changes: ChangeWithoutId[] = [];

    for (const correspondence of correspondences.value.values()) {
        const before = fromMap.value.get(correspondence.beforeKey) as PgObjectInfo;
        const after = toMap.value.get(correspondence.afterKey) as PgObjectInfo;
        pairedBefore.add(correspondence.beforeKey);
        pairedAfter.add(correspondence.afterKey);
        const differences = objectDifferences(before, after);
        if (correspondence.authoredRename) {
            changes.push(makeChange(
                "rename",
                "authored",
                differences.length === 0 ? "preserving" : classifyAlter(before, after, differences),
                before,
                after,
                differences,
                fromMap.value,
                toMap.value,
            ));
        } else if (differences.length > 0) {
            changes.push(makeChange(
                "alter",
                "inferred",
                classifyAlter(before, after, differences),
                before,
                after,
                differences,
                fromMap.value,
                toMap.value,
            ));
        }
    }

    const commonKeys = [...fromMap.value.keys()]
        .filter(key => toMap.value.has(key) && !pairedBefore.has(key) && !pairedAfter.has(key))
        .sort(compareUtf16);
    for (const key of commonKeys) {
        const before = fromMap.value.get(key) as PgObjectInfo;
        const after = toMap.value.get(key) as PgObjectInfo;
        pairedBefore.add(key);
        pairedAfter.add(key);
        const differences = objectDifferences(before, after);
        if (differences.length === 0) continue;
        changes.push(makeChange(
            "alter",
            "inferred",
            classifyAlter(before, after, differences),
            before,
            after,
            differences,
            fromMap.value,
            toMap.value,
        ));
    }

    for (const key of [...fromMap.value.keys()].filter(one => !pairedBefore.has(one)).sort(compareUtf16)) {
        const before = fromMap.value.get(key) as PgObjectInfo;
        changes.push(makeChange(
            "remove",
            "inferred",
            classifyRemove(before),
            before,
            null,
            [],
            fromMap.value,
            toMap.value,
        ));
    }
    for (const key of [...toMap.value.keys()].filter(one => !pairedAfter.has(one)).sort(compareUtf16)) {
        const after = toMap.value.get(key) as PgObjectInfo;
        changes.push(makeChange(
            "add",
            "inferred",
            classifyAdd(after),
            null,
            after,
            [],
            fromMap.value,
            toMap.value,
        ));
    }

    changes.sort((left, right) => compareUtf16(changeSortKey(left), changeSortKey(right)));
    return {
        ok: true,
        value: changes.map(change => ({id: changeId(base, change), ...change})),
    };
}

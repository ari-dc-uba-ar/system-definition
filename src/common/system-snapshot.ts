import {JsonValue, toJsonValue} from "./json-value";
import {ValidationResult, problem} from "./problem";
import {childPath, exactKeys, isPlainObject} from "./decode-structure";
import {EntityDef, EntityInfoOf, SystemEntityContext, completeEntity} from "./ssot-entity";
import {RecordDef, RecordInfoOf, completeRecord} from "./ssot-record";

export type SnapshotFieldInfo = {
    readonly [key: string]: JsonValue
    name: string
    type: string
    nullable: boolean
};

export type SnapshotEntityInfo = {
    name: string
    record: string
    fields: Readonly<Record<string, SnapshotFieldInfo>>
    pk: readonly string[]
    uks: Readonly<Record<string, readonly string[]>>
    fks: Readonly<Record<string, {
        entity: string
        fields: Readonly<Record<string, string>>
    }>>
    validators: readonly string[]
};

export type SystemSnapshotInfo = {
    formatVersion: 1
    systemId: string
    typeNames: readonly string[]
    entities: Readonly<Record<string, SnapshotEntityInfo>>
    records: Readonly<Record<string, Readonly<Record<string, SnapshotFieldInfo>>>>
};

export type SystemSnapshotInput<TContext extends SystemEntityContext> = {
    systemId: string
    entities: Readonly<Record<string, EntityDef<TContext>>>
    records?: Readonly<Record<string, RecordDef<TContext>>>
};

type SnapshotRecordsOf<TContext extends SystemEntityContext, TInput> =
    TInput extends {records: infer TRecords extends Readonly<Record<string, RecordDef<TContext>>>}
        ? {[K in keyof TRecords]: RecordInfoOf<TContext, TRecords[K]>}
        : {};

export type SystemSnapshotInfoOf<
    TContext extends SystemEntityContext,
    TInput extends SystemSnapshotInput<TContext>,
> = {
    formatVersion: 1
    systemId: TInput["systemId"]
    typeNames: readonly (keyof TContext["types"] & string)[]
    entities: {[K in keyof TInput["entities"]]: EntityInfoOf<TContext, TInput["entities"][K]>}
    records: SnapshotRecordsOf<TContext, TInput>
};

type JsonObject = {readonly [key: string]: JsonValue};

type SnapshotDecodeResult<T> = ValidationResult<T>;

function invalidSnapshot(path: string, reason: string): SnapshotDecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.unsupportedFormat", "blocking", {path, reason})],
    };
}

function invalidReference(path: string, reason: string): SnapshotDecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidReference", "blocking", {path, reason})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}

function stringArray(value: JsonValue, path: string): SnapshotDecodeResult<readonly string[]> {
    if (!Array.isArray(value)) return invalidSnapshot(path, "expected an array of strings");
    const result: string[] = [];
    for (let index = 0; index < value.length; index++) {
        if (typeof value[index] !== "string") {
            return invalidSnapshot(path + "[" + index + "]", "expected a string");
        }
        result.push(value[index] as string);
    }
    return {ok: true, value: result};
}

function fieldMap(
    value: JsonValue,
    typeNames: ReadonlySet<string>,
    path: string,
): SnapshotDecodeResult<Readonly<Record<string, SnapshotFieldInfo>>> {
    if (!isObject(value)) return invalidSnapshot(path, "expected a field map");

    const result: Record<string, SnapshotFieldInfo> = Object.create(null) as Record<string, SnapshotFieldInfo>;
    for (const [fieldName, rawField] of Object.entries(value)) {
        const fieldPath = childPath(path, fieldName);
        if (!isObject(rawField)) return invalidSnapshot(fieldPath, "expected a field object");

        if (typeof rawField.name !== "string") {
            return invalidSnapshot(childPath(fieldPath, "name"), "expected a string");
        }
        if (rawField.name !== fieldName) {
            return invalidSnapshot(childPath(fieldPath, "name"), "field name does not match its key");
        }
        if (typeof rawField.type !== "string") {
            return invalidSnapshot(childPath(fieldPath, "type"), "expected a string");
        }
        if (!typeNames.has(rawField.type)) {
            return invalidReference(childPath(fieldPath, "type"), "unknown type " + JSON.stringify(rawField.type));
        }
        if (typeof rawField.nullable !== "boolean") {
            return invalidSnapshot(childPath(fieldPath, "nullable"), "expected a boolean");
        }

        result[fieldName] = rawField as SnapshotFieldInfo;
    }
    return {ok: true, value: result};
}

function keyCollection(
    value: JsonValue,
    fields: Readonly<Record<string, SnapshotFieldInfo>>,
    path: string,
): SnapshotDecodeResult<Readonly<Record<string, readonly string[]>>> {
    if (!isObject(value)) return invalidSnapshot(path, "expected a key map");
    const result: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;

    for (const [keyName, rawFields] of Object.entries(value)) {
        const keyPath = childPath(path, keyName);
        const decoded = stringArray(rawFields, keyPath);
        if (!decoded.ok) return decoded;
        if (decoded.value.length === 0) return invalidSnapshot(keyPath, "key must contain at least one field");
        for (let index = 0; index < decoded.value.length; index++) {
            const fieldName = decoded.value[index];
            if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
                return invalidReference(keyPath + "[" + index + "]", "unknown field " + JSON.stringify(fieldName));
            }
        }
        result[keyName] = decoded.value;
    }
    return {ok: true, value: result};
}

function fkMap(
    value: JsonValue,
    sourceFields: Readonly<Record<string, SnapshotFieldInfo>>,
    path: string,
): SnapshotDecodeResult<Readonly<Record<string, {entity: string, fields: Readonly<Record<string, string>>}>>> {
    if (!isObject(value)) return invalidSnapshot(path, "expected an fk map");
    const result: Record<string, {entity: string, fields: Readonly<Record<string, string>>}> = Object.create(null);

    for (const [fkName, rawFk] of Object.entries(value)) {
        const fkPath = childPath(path, fkName);
        if (!isObject(rawFk)) return invalidSnapshot(fkPath, "expected an fk object");
        const shape = exactKeys(rawFk, ["entity", "fields"], fkPath, invalidSnapshot);
        if (!shape.ok) return shape;
        if (typeof rawFk.entity !== "string") {
            return invalidSnapshot(childPath(fkPath, "entity"), "expected a string");
        }
        if (!isObject(rawFk.fields)) {
            return invalidSnapshot(childPath(fkPath, "fields"), "fk fields must be a normalized source-to-target map");
        }

        const fields: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [sourceName, rawTargetName] of Object.entries(rawFk.fields)) {
            const sourcePath = childPath(childPath(fkPath, "fields"), sourceName);
            if (!Object.prototype.hasOwnProperty.call(sourceFields, sourceName)) {
                return invalidReference(sourcePath, "unknown source field " + JSON.stringify(sourceName));
            }
            if (typeof rawTargetName !== "string") {
                return invalidSnapshot(sourcePath, "expected a target field name");
            }
            fields[sourceName] = rawTargetName;
        }
        result[fkName] = {entity: rawFk.entity, fields};
    }
    return {ok: true, value: result};
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return rightSet.size === right.length && left.every(name => rightSet.has(name));
}

function validateFkTargets(
    entities: Readonly<Record<string, SnapshotEntityInfo>>,
): SnapshotDecodeResult<true> {
    for (const [entityName, entity] of Object.entries(entities)) {
        for (const [fkName, fk] of Object.entries(entity.fks)) {
            const fkPath = childPath(childPath(childPath("$", "entities"), entityName), "fks");
            const path = childPath(fkPath, fkName);
            const target = entities[fk.entity];
            if (target === undefined) {
                return invalidReference(childPath(path, "entity"), "unknown target entity " + JSON.stringify(fk.entity));
            }

            const targets = Object.values(fk.fields);
            if (new Set(targets).size !== targets.length) {
                return invalidReference(childPath(path, "fields"), "fk target fields must not repeat");
            }
            for (const targetName of targets) {
                if (!Object.prototype.hasOwnProperty.call(target.fields, targetName)) {
                    return invalidReference(childPath(path, "fields"), "unknown target field " + JSON.stringify(targetName));
                }
            }

            const matchesPk = sameStringSet(targets, target.pk);
            const matchesUk = Object.values(target.uks).some(uk => sameStringSet(targets, uk));
            if (!matchesPk && !matchesUk) {
                return invalidReference(childPath(path, "fields"), "fk target must match one complete pk or uk");
            }
        }
    }
    return {ok: true, value: true};
}

function decodeCopiedSnapshot(value: JsonValue): SnapshotDecodeResult<SystemSnapshotInfo> {
    if (!isObject(value)) return invalidSnapshot("$", "expected a snapshot object");
    const topShape = exactKeys(value, ["formatVersion", "systemId", "typeNames", "entities", "records"], "$", invalidSnapshot);
    if (!topShape.ok) return topShape;

    if (value.formatVersion !== 1) {
        return invalidSnapshot("$[\"formatVersion\"]", "unsupported snapshot format version");
    }
    if (typeof value.systemId !== "string" || value.systemId.trim().length === 0) {
        return invalidSnapshot("$[\"systemId\"]", "system id must be a non-empty string");
    }

    const decodedTypeNames = stringArray(value.typeNames, "$[\"typeNames\"]");
    if (!decodedTypeNames.ok) return decodedTypeNames;
    const typeNameSet = new Set(decodedTypeNames.value);
    if (typeNameSet.size !== decodedTypeNames.value.length) {
        return invalidSnapshot("$[\"typeNames\"]", "type names must not repeat");
    }

    if (!isObject(value.records)) return invalidSnapshot("$[\"records\"]", "expected a record map");
    const records: Record<string, Readonly<Record<string, SnapshotFieldInfo>>> = Object.create(null);
    for (const [recordName, rawFields] of Object.entries(value.records)) {
        const decodedFields = fieldMap(rawFields, typeNameSet, childPath("$[\"records\"]", recordName));
        if (!decodedFields.ok) return decodedFields;
        records[recordName] = decodedFields.value;
    }

    if (!isObject(value.entities)) return invalidSnapshot("$[\"entities\"]", "expected an entity map");
    const entities: Record<string, SnapshotEntityInfo> = Object.create(null) as Record<string, SnapshotEntityInfo>;
    for (const [entityName, rawEntity] of Object.entries(value.entities)) {
        const entityPath = childPath("$[\"entities\"]", entityName);
        if (!isObject(rawEntity)) return invalidSnapshot(entityPath, "expected an entity object");
        const entityShape = exactKeys(rawEntity, ["name", "record", "fields", "pk", "uks", "fks", "validators"], entityPath, invalidSnapshot);
        if (!entityShape.ok) return entityShape;

        if (typeof rawEntity.name !== "string") {
            return invalidSnapshot(childPath(entityPath, "name"), "expected a string");
        }
        if (rawEntity.name !== entityName) {
            return invalidSnapshot(childPath(entityPath, "name"), "entity name does not match its key");
        }
        if (typeof rawEntity.record !== "string") {
            return invalidSnapshot(childPath(entityPath, "record"), "expected a string");
        }

        const decodedFields = fieldMap(rawEntity.fields, typeNameSet, childPath(entityPath, "fields"));
        if (!decodedFields.ok) return decodedFields;
        const decodedPk = stringArray(rawEntity.pk, childPath(entityPath, "pk"));
        if (!decodedPk.ok) return decodedPk;
        if (decodedPk.value.length === 0) return invalidSnapshot(childPath(entityPath, "pk"), "pk must not be empty");
        if (new Set(decodedPk.value).size !== decodedPk.value.length) {
            return invalidSnapshot(childPath(entityPath, "pk"), "pk must be normalized without duplicates");
        }
        for (let index = 0; index < decodedPk.value.length; index++) {
            const fieldName = decodedPk.value[index];
            const field = decodedFields.value[fieldName];
            if (field === undefined) {
                return invalidReference(childPath(entityPath, "pk") + "[" + index + "]", "unknown pk field " + JSON.stringify(fieldName));
            }
            if (field.nullable) {
                return invalidSnapshot(childPath(childPath(entityPath, "fields"), fieldName), "pk field must not be nullable");
            }
        }

        const decodedUks = keyCollection(rawEntity.uks, decodedFields.value, childPath(entityPath, "uks"));
        if (!decodedUks.ok) return decodedUks;
        const decodedFks = fkMap(rawEntity.fks, decodedFields.value, childPath(entityPath, "fks"));
        if (!decodedFks.ok) return decodedFks;
        const decodedValidators = stringArray(rawEntity.validators, childPath(entityPath, "validators"));
        if (!decodedValidators.ok) return decodedValidators;

        entities[entityName] = {
            name: rawEntity.name,
            record: rawEntity.record,
            fields: decodedFields.value,
            pk: decodedPk.value,
            uks: decodedUks.value,
            fks: decodedFks.value,
            validators: decodedValidators.value,
        };
    }

    const fksValid = validateFkTargets(entities);
    if (!fksValid.ok) return fksValid;

    return {
        ok: true,
        value: {
            formatVersion: 1,
            systemId: value.systemId,
            typeNames: decodedTypeNames.value,
            entities,
            records,
        },
    };
}

export function decodeSystemSnapshot(value: unknown): ValidationResult<SystemSnapshotInfo> {
    const copied = toJsonValue(value);
    if (!copied.ok) return copied;
    return decodeCopiedSnapshot(copied.value);
}

export function captureSystemSnapshot<
    const TContext extends SystemEntityContext,
    const TInput extends SystemSnapshotInput<TContext>,
>(
    context: TContext,
    input: TInput,
): ValidationResult<SystemSnapshotInfoOf<TContext, TInput>> {
    /* Copy the Def-side input before the system completer can read it. Besides detaching aliases,
       this makes accessors and other non-JSON values fail at the boundary instead of executing. */
    const copiedInput = toJsonValue(input);
    if (!copiedInput.ok) return copiedInput;
    if (!isObject(copiedInput.value)) return invalidSnapshot("$", "expected snapshot capture input") as ValidationResult<SystemSnapshotInfoOf<TContext, TInput>>;

    const systemId = copiedInput.value.systemId;
    const rawEntities = copiedInput.value.entities;
    const rawRecords = copiedInput.value.records;
    if (typeof systemId !== "string" || systemId.trim().length === 0) {
        return invalidSnapshot("$[\"systemId\"]", "system id must be a non-empty string") as ValidationResult<SystemSnapshotInfoOf<TContext, TInput>>;
    }
    if (!isObject(rawEntities)) {
        return invalidSnapshot("$[\"entities\"]", "expected an entity map") as ValidationResult<SystemSnapshotInfoOf<TContext, TInput>>;
    }
    if (rawRecords !== undefined && !isObject(rawRecords)) {
        return invalidSnapshot("$[\"records\"]", "expected a record map") as ValidationResult<SystemSnapshotInfoOf<TContext, TInput>>;
    }

    try {
        const entities = Object.fromEntries(Object.entries(rawEntities).map(([name, entityDef]) => [
            name,
            completeEntity(context, entityDef as unknown as EntityDef<TContext>),
        ]));
        const records = rawRecords === undefined
            ? {}
            : Object.fromEntries(Object.entries(rawRecords).map(([name, recordDef]) => [
                name,
                completeRecord(context, recordDef as unknown as RecordDef<TContext>),
            ]));

        const decoded = decodeSystemSnapshot({
            formatVersion: 1,
            systemId,
            typeNames: Object.keys(context.types),
            entities,
            records,
        });
        return decoded as ValidationResult<SystemSnapshotInfoOf<TContext, TInput>>;
    } catch {
        return invalidSnapshot("$", "snapshot definitions could not be completed safely") as ValidationResult<SystemSnapshotInfoOf<TContext, TInput>>;
    }
}

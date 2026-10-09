import {
    compareUtf16,
    hasExactKeys,
    isPlainObject,
    problem,
    type PersistenceInfo,
    type Problem,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import type {PortInfo} from "./migration-authoring";
import type {StorageContext} from "./pg-schema";
import type {ValidationModule} from "./validation-artifact";

export type MachineValue = string | null;
export type MachineRow = Readonly<Record<string, MachineValue>>;

function invalid<T>(reason: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.dataValidationInvalid", "blocking", {reason, ...details})],
    };
}

function decodeMachineRow(
    value: unknown,
    expectedKeys: readonly string[],
    rowIndex: number,
    scope: string,
): ValidationResult<MachineRow> {
    if (!isPlainObject(value)) {
        return invalid("machine row must be an object record", {scope, rowIndex: String(rowIndex)});
    }
    const actualKeys = Object.keys(value);
    if (!hasExactKeys(value, expectedKeys)) {
        const expected = new Set(expectedKeys);
        const actual = new Set(actualKeys);
        const missing = expectedKeys.filter(key => !actual.has(key));
        const unexpected = actualKeys.filter(key => !expected.has(key));
        return invalid("machine row fields do not match the historical contract", {
            scope,
            rowIndex: String(rowIndex),
            missing: missing.join(","),
            unexpected: unexpected.join(","),
        });
    }

    const source = value;
    const decoded = {} as Record<string, MachineValue>;
    for (const key of expectedKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined || !("value" in descriptor)) {
            return invalid("machine row field must be an own data property", {
                scope,
                rowIndex: String(rowIndex),
                field: key,
            });
        }
        const fieldValue = descriptor.value;
        if (fieldValue !== null && typeof fieldValue !== "string") {
            return invalid("machine row field must be string or null", {
                scope,
                rowIndex: String(rowIndex),
                field: key,
            });
        }
        Object.defineProperty(decoded, key, {
            value: fieldValue,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return {ok: true, value: decoded};
}

function decodeRows(
    rows: readonly MachineRow[],
    expectedKeys: readonly string[],
    scope: string,
): ValidationResult<readonly MachineRow[]> {
    const decoded: MachineRow[] = [];
    const problems: Problem[] = [];
    for (let index = 0; index < rows.length; index++) {
        const row = decodeMachineRow(rows[index], expectedKeys, index, scope);
        if (row.ok) decoded.push(row.value);
        else problems.push(...row.problems);
    }
    if (problems.length !== 0) return {ok: false, problems};
    return {ok: true, value: decoded};
}

function collectHistoricalProblems(
    rows: readonly MachineRow[],
    validate: (row: MachineRow) => readonly Problem[],
    scope: string,
): ValidationResult<readonly MachineRow[]> {
    const problems: Problem[] = [];
    for (let index = 0; index < rows.length; index++) {
        let rowProblems: readonly Problem[];
        try {
            const returned = validate(rows[index]);
            if (!Array.isArray(returned)) {
                return invalid("historical validator returned an invalid problem list", {
                    scope,
                    rowIndex: String(index),
                });
            }
            rowProblems = returned;
        } catch (error) {
            return invalid("historical validator threw", {
                scope,
                rowIndex: String(index),
                error: error instanceof Error ? error.message : String(error),
            });
        }
        problems.push(...rowProblems);
    }
    // Every historical Problem is blocking evidence for migration verification. Severity
    // controls validation sequencing inside the historical domain, not deployment permission.
    if (problems.length !== 0) return {ok: false, problems};
    return {ok: true, value: rows};
}

export function validateMachinePortRows(
    runtime: ValidationModule,
    ports: Readonly<Record<string, PortInfo>>,
    rows: readonly MachineRow[],
): ValidationResult<readonly MachineRow[]> {
    const decoded = decodeRows(rows, Object.keys(ports), "ports");
    if (!decoded.ok) return decoded;
    return collectHistoricalProblems(
        decoded.value,
        row => runtime.validatePorts(ports, row),
        "ports",
    );
}

export function validateMachineEntityRows(
    snapshot: SystemSnapshotInfo,
    runtime: ValidationModule,
    entity: string,
    rows: readonly MachineRow[],
): ValidationResult<readonly MachineRow[]> {
    const entityInfo = snapshot.entities[entity];
    if (entityInfo === undefined) return invalid("unknown historical entity", {entity});

    const decoded = decodeRows(rows, Object.keys(entityInfo.fields), `entity:${entity}`);
    if (!decoded.ok) return decoded;
    return collectHistoricalProblems(
        decoded.value,
        row => runtime.validateEntityRow(entity, row),
        `entity:${entity}`,
    );
}

export type MachineReadProjectionField = {
    field: string;
    sourceColumn: string;
    readExpression: string;
};

export type MachineReadProjectionRequest = {
    sql: string;
    entity: string;
    fields: readonly MachineReadProjectionField[];
};

export type MachineReadProjector = {
    project(request: MachineReadProjectionRequest): ValidationResult<string>;
};


export function compileMachineEntityReadQuery(
    snapshot: SystemSnapshotInfo,
    entity: string,
    persistence: PersistenceInfo,
    storage: StorageContext,
    sourceSql: string,
    projector: MachineReadProjector,
): ValidationResult<string> {
    const entityInfo = snapshot.entities[entity];
    if (entityInfo === undefined) return invalid("unknown historical entity", {entity});

    return compileMachineFieldsReadQuery(entityInfo.fields, entity, persistence, storage, sourceSql, projector);
}

export function compileMachinePortReadQuery(
    ports: Readonly<Record<string, PortInfo>>, persistence: PersistenceInfo, storage: StorageContext,
    sourceSql: string, projector: MachineReadProjector,
): ValidationResult<string> {
    return compileMachineFieldsReadQuery(Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, {type: port.domain.type}])),
        "ports", persistence, storage, sourceSql, projector);
}

function compileMachineFieldsReadQuery(
    entityFields: Readonly<Record<string, {type: string}>>, entity: string,
    persistence: PersistenceInfo, storage: StorageContext, sourceSql: string, projector: MachineReadProjector,
): ValidationResult<string> {

    const representation = persistence.representations[storage.representation];
    if (representation === undefined) {
        return invalid("physical type representation is missing", {representation: storage.representation});
    }

    const fields: MachineReadProjectionField[] = [];
    for (const fieldName of Object.keys(entityFields).sort(compareUtf16)) {
        const field = entityFields[fieldName]!;
        const physicalName = representation[field.type];
        if (physicalName === undefined || physicalName.length === 0) {
            return invalid("physical type mapping is missing", {
                entity,
                field: fieldName,
                logicalType: field.type,
                representation: storage.representation,
            });
        }
        if (storage.physicalTypes[physicalName] === undefined) {
            return invalid("physical type is missing from storage context", {
                entity,
                field: fieldName,
                physicalType: physicalName,
            });
        }

        const codec = storage.machineCodecs?.[physicalName];
        if (codec === undefined) {
            return invalid("machine codec is missing", {
                entity,
                field: fieldName,
                physicalType: physicalName,
            });
        }
        if (codec.readExpression.length === 0) {
            return invalid("machine codec read expression is missing", {
                entity,
                field: fieldName,
                physicalType: physicalName,
            });
        }
        if (codec.transportType.length === 0 || storage.physicalTypes[codec.transportType] === undefined) {
            return invalid("codec transport type is missing", {
                entity,
                field: fieldName,
                physicalType: physicalName,
                transportType: codec.transportType,
            });
        }

        fields.push({
            field: fieldName,
            sourceColumn: fieldName,
            readExpression: codec.readExpression,
        });
    }

    let projected: ValidationResult<string>;
    try {
        projected = projector.project({
            sql: sourceSql,
            entity,
            fields,
        });
    } catch (error) {
        return invalid("machine read projector threw", {
            entity,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    if (!projected.ok) return projected;
    if (typeof projected.value !== "string" || projected.value.length === 0) {
        return invalid("machine read projector returned invalid SQL", {entity});
    }
    return projected;
}

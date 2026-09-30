import {
    problem,
    type Problem,
    type SystemSnapshotInfo,
    type ValidationResult,
} from "system-definition";
import type {PortInfo} from "./migration-authoring";
import type {ValidationModule} from "./validation-artifact";

export type MachineValue = string | null;
export type MachineRow = Readonly<Record<string, MachineValue>>;

function invalid<T>(reason: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.dataValidationInvalid", "blocking", {reason, ...details})],
    };
}

function ownKeys(value: unknown): readonly string[] | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return Object.keys(value);
}

function sameKeySet(actual: readonly string[], expected: readonly string[]): boolean {
    if (actual.length !== expected.length) return false;
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    return actualSorted.every((key, index) => key === expectedSorted[index]);
}

function decodeMachineRow(
    value: unknown,
    expectedKeys: readonly string[],
    rowIndex: number,
    scope: string,
): ValidationResult<MachineRow> {
    const actualKeys = ownKeys(value);
    if (actualKeys === null) {
        return invalid("machine row must be an object record", {scope, rowIndex: String(rowIndex)});
    }
    if (!sameKeySet(actualKeys, expectedKeys)) {
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

    const source = value as Record<string, unknown>;
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

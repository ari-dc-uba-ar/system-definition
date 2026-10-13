import {childPath, decodeArray, decodeContentRefInfo, exactOptionalKeys, hasExactKeys, isNonEmptyString, isPlainObject,
    type StructuralFailure, type ValidationResult} from "system-definition";
import type {DataMigrationInfo, DomainRefInfo, FieldRefInfo, MachineValueInfo, PortInfo, WriteInfo} from "./migration-authoring";

export function decodeFieldRefInfo(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<FieldRefInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["side", "entity", "field"])
        || (value.side !== "from" && value.side !== "to") || !isNonEmptyString(value.entity) || !isNonEmptyString(value.field)) return invalid(path, "invalid field reference");
    return {ok: true, value: {side: value.side, entity: value.entity, field: value.field}};
}

export function decodeDomainRefInfo(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<DomainRefInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["side", "type", "nullable"])
        || (value.side !== "from" && value.side !== "to") || !isNonEmptyString(value.type) || typeof value.nullable !== "boolean") return invalid(path, "invalid domain reference");
    return {ok: true, value: {side: value.side, type: value.type, nullable: value.nullable}};
}

export function decodePortInfo(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<PortInfo> {
    if (!isPlainObject(value) || !hasExactKeys(value, ["domain", "field"])) return invalid(path, "invalid port");
    const domain = decodeDomainRefInfo(value.domain, path + ".domain", invalid); if (!domain.ok) return domain;
    const field = value.field === null ? {ok: true as const, value: null} : decodeFieldRefInfo(value.field, path + ".field", invalid);
    return field.ok ? {ok: true, value: {domain: domain.value, field: field.value}} : field;
}

export function decodeNames(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<readonly string[]> {
    const names = decodeArray(value, path, invalid, (raw, at) => isNonEmptyString(raw) ? {ok: true, value: raw} : invalid(at, "expected a non-empty string"));
    if (!names.ok) return names;
    return new Set(names.value).size === names.value.length ? names : invalid(path, "duplicate value");
}

function decodeWrite(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<WriteInfo> {
    if (!isPlainObject(value) || (value.kind !== "insert" && value.kind !== "update")
        || !hasExactKeys(value, ["kind", "entity", "values", ...(value.kind === "insert" ? ["key"] : ["match", "whenMissing"])])
        || !isNonEmptyString(value.entity)) return invalid(path, "invalid write");
    const bindings = decodeArray(value.values, path + ".values", invalid, (raw, at) => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["output", "target"]) || !isNonEmptyString(raw.output)) return invalid(at, "invalid output binding");
        const target = decodeFieldRefInfo(raw.target, at + ".target", invalid);
        return target.ok ? {ok: true, value: {output: raw.output, target: target.value}} : target;
    });
    if (!bindings.ok) return bindings;
    if (value.kind === "insert") {
        const key = decodeNames(value.key, path + ".key", invalid); if (!key.ok) return key;
        return {ok: true, value: {kind: "insert", entity: value.entity, values: bindings.value, key: key.value}};
    }
    const match = decodeArray(value.match, path + ".match", invalid, (raw, at) => {
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["output", "targetField"]) || !isNonEmptyString(raw.output) || !isNonEmptyString(raw.targetField)) return invalid(at, "invalid match pair");
        return {ok: true, value: {output: raw.output, targetField: raw.targetField}};
    });
    if (!match.ok) return match;
    if (value.whenMissing !== "error" && value.whenMissing !== "insert") return invalid(path + ".whenMissing", "expected error or insert");
    return {ok: true, value: {kind: "update", entity: value.entity, values: bindings.value, match: match.value, whenMissing: value.whenMissing}};
}

/** Complete the serializable data shape; snapshot and transformation compatibility are checked separately. */
export function decodeDataMigrationShape(value: unknown, path: string, invalid: StructuralFailure): ValidationResult<DataMigrationInfo> {
    if (!isPlainObject(value)) return invalid(path, "expected a data migration");
    const shape = exactOptionalKeys(value, ["id", "source", "transformation", "arguments", "writes"], ["description", "dependsOn", "conservationChecks"], path, invalid);
    if (!shape.ok) return shape;
    if (!isNonEmptyString(value.id) || !isNonEmptyString(value.transformation) || (value.description !== undefined && typeof value.description !== "string")) return invalid(path, "invalid data migration identity");
    const dependsOn = decodeNames((value.dependsOn === undefined ? [] : value.dependsOn), path + ".dependsOn", invalid); if (!dependsOn.ok) return dependsOn;
    if (!isPlainObject(value.source)) return invalid(path + ".source", "expected a source selection");
    const sourceShape = exactOptionalKeys(value.source, ["query", "ports", "identity"], ["coverageChecks"], path + ".source", invalid);
    if (!sourceShape.ok) return sourceShape;
    const query = decodeContentRefInfo(value.source.query, path + ".source.query", "query", invalid); if (!query.ok) return query;
    if (!isPlainObject(value.source.ports)) return invalid(path + ".source.ports", "expected ports");
    const ports: Record<string, PortInfo> = Object.create(null);
    for (const [name, raw] of Object.entries(value.source.ports)) {
        const at = childPath(path + ".source.ports", name);
        if (!isNonEmptyString(name) || name.startsWith("__")) return invalid(at, "invalid port name");
        const port = decodePortInfo(raw, at, invalid); if (!port.ok) return port;
        ports[name] = port.value;
    }
    const identity = decodeNames(value.source.identity, path + ".source.identity", invalid); if (!identity.ok) return identity;
    const checks = (raw: unknown, at: string) => decodeArray(raw, at, invalid, (item, itemPath) => decodeContentRefInfo(item, itemPath, "check", invalid));
    const coverage = checks((value.source.coverageChecks === undefined ? [] : value.source.coverageChecks), path + ".source.coverageChecks"); if (!coverage.ok) return coverage;
    if (!isPlainObject(value.arguments)) return invalid(path + ".arguments", "expected arguments");
    const args: Record<string, MachineValueInfo> = Object.create(null);
    for (const [name, raw] of Object.entries(value.arguments)) {
        const at = childPath(path + ".arguments", name);
        if (!isPlainObject(raw) || !hasExactKeys(raw, ["domain", "value"]) || (raw.value !== null && typeof raw.value !== "string")) return invalid(at, "invalid machine value");
        const domain = decodeDomainRefInfo(raw.domain, at + ".domain", invalid); if (!domain.ok) return domain;
        args[name] = {domain: domain.value, value: raw.value};
    }
    const writes = decodeArray(value.writes, path + ".writes", invalid, (raw, at) => decodeWrite(raw, at, invalid)); if (!writes.ok) return writes;
    const conservation = checks((value.conservationChecks === undefined ? [] : value.conservationChecks), path + ".conservationChecks"); if (!conservation.ok) return conservation;
    return {ok: true, value: {id: value.id, description: value.description ?? "", dependsOn: dependsOn.value,
        source: {query: query.value, ports, identity: identity.value, coverageChecks: coverage.value},
        transformation: value.transformation, arguments: args, writes: writes.value, conservationChecks: conservation.value}};
}

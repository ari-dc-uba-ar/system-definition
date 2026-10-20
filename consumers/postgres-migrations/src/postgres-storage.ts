import {childPath, exactOptionalKeys, isPlainObject, problem, toJsonValue, type SystemSnapshotInfo, type ValidationResult} from "system-definition";
import type {PgObjectInfo, PgTypeRepresentation} from "./pg-schema";
import {isPgStoredIdentifier} from "./pg-sql";
import {isPgNonEmptyText} from "./pg-text";

export type PostgresIdentityMode = "byDefault" | "always";
export type PostgresColumnStorageDef = {
    typeModifiers?: readonly number[] | null;
    identity?: PostgresIdentityMode | null;
};
type ConstraintTiming = Pick<Extract<PgObjectInfo, {kind: "constraint"}>, "deferrable" | "initiallyDeferred">;
export type PostgresKeyStorageDef = Partial<ConstraintTiming> & {name?: string | null};
export type PostgresKeyStorageInfo = ConstraintTiming & {name: string | null};
export type PostgresCheckStorageDef<TField extends string = string> =
    Pick<Extract<PgObjectInfo, {kind: "constraint"}>, "definition"> & {columns: readonly TField[]};
export type PostgresIndexStorageDef = Pick<Extract<PgObjectInfo, {kind: "index"}>, "definition">;
export type PostgresStorageDef<TSnapshot extends Pick<SystemSnapshotInfo, "entities">> = {
    entities: {readonly [E in keyof TSnapshot["entities"]]?: {
        columns?: {readonly [F in keyof TSnapshot["entities"][E]["fields"]]?: PostgresColumnStorageDef};
        primaryKey?: {name: string} | null;
        foreignKeys?: keyof TSnapshot["entities"][E]["fks"] extends never ? never : {readonly [K in keyof TSnapshot["entities"][E]["fks"]]?: PostgresKeyStorageDef};
        uniqueKeys?: keyof TSnapshot["entities"][E]["uks"] extends never ? never : {readonly [K in keyof TSnapshot["entities"][E]["uks"]]?: PostgresKeyStorageDef};
        checks?: Readonly<Record<string, PostgresCheckStorageDef<Extract<keyof TSnapshot["entities"][E]["fields"], string>>>>;
        indexes?: Readonly<Record<string, PostgresIndexStorageDef>>;
    }};
};
export type PostgresColumnStorageInfo = {
    typeModifiers: readonly number[] | null;
    identity: PostgresIdentityMode | null;
};
export type PostgresStorageInfo = {
    entities: Readonly<Record<string, {
        columns: Readonly<Record<string, PostgresColumnStorageInfo>>;
        primaryKey: {name: string} | null;
        foreignKeys?: Readonly<Record<string, PostgresKeyStorageInfo>>;
        uniqueKeys?: Readonly<Record<string, PostgresKeyStorageInfo>>;
        checks?: Readonly<Record<string, PostgresCheckStorageDef>>;
        indexes?: Readonly<Record<string, PostgresIndexStorageDef>>;
    }>>;
};

function invalid(path: string, reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.unsupportedFormat", "blocking", {path, reason})]};
}

function objectKeys(value: unknown, keys: readonly string[], path: string): ValidationResult<Readonly<Record<string, unknown>>> {
    if (!isPlainObject(value)) return invalid(path, "Expected a PostgreSQL storage object");
    const shape = exactOptionalKeys(value, [], keys, path, invalid);
    return shape.ok ? {ok: true, value} : shape;
}

/** PostgreSQL 18 type parameters; numeric(p) is printed by the catalog as numeric(p,0). */
function typeModifiers(value: unknown, type: PgTypeRepresentation, path: string): ValidationResult<readonly number[] | null> {
    if (value === undefined || value === null) return {ok: true, value: null};
    if (!Array.isArray(value)) return invalid(path, "Expected numeric type parameters");
    const numbers: number[] = [];
    for (const number of value) {
        if (typeof number !== "number" || !Number.isSafeInteger(number)) return invalid(path, "Type parameters must be safe integers");
        numbers.push(number);
    }
    if (numbers.length === 0) return {ok: true, value: numbers};
    const [precision, scale = 0] = numbers;
    const supported = type.schema === "pg_catalog" && (type.name === "varchar" ? numbers.length === 1 && precision >= 1 && precision <= 10_485_760
        : type.name === "numeric" ? numbers.length <= 2 && precision >= 1 && precision <= 1000 && scale >= -1000 && scale <= 1000
        : ["time", "timestamp", "timestamptz"].includes(type.name)
            && numbers.length === 1 && precision >= 0 && precision <= 6);
    if (!supported) return invalid(path, "Unsupported parameters for SQL type " + type.schema + "." + type.name);
    return {ok: true, value: type.name === "numeric" ? [precision, scale] : numbers};
}

function decodeColumn(value: unknown, type: PgTypeRepresentation, nullable: boolean, path: string): ValidationResult<PostgresColumnStorageInfo> {
    const object = objectKeys(value, ["typeModifiers", "identity"], path);
    if (!object.ok) return object;
    const modifiers = typeModifiers(object.value.typeModifiers, type, childPath(path, "typeModifiers"));
    if (!modifiers.ok) return modifiers;
    const identity = object.value.identity ?? null;
    if (identity !== null && identity !== "byDefault" && identity !== "always") return invalid(childPath(path, "identity"), "Unknown identity mode");
    if (identity !== null && (nullable || type.schema !== "pg_catalog" || !["int2", "int4", "int8"].includes(type.name))) {
        return invalid(path, "An identity requires a non-nullable integer column");
    }
    return {ok: true, value: {typeModifiers: modifiers.value, identity}};
}

function decodePrimaryKey(value: unknown, path: string): ValidationResult<{name: string} | null> {
    if (value === undefined || value === null) return {ok: true, value: null};
    const object = objectKeys(value, ["name"], path);
    if (!object.ok) return object;
    const name = object.value.name;
    if (!isPgStoredIdentifier(name)) return invalid(path, "Invalid PostgreSQL primary-key name");
    return {ok: true, value: {name}};
}

function decodeKeys(value: unknown, known: Readonly<Record<string, unknown>>, path: string): ValidationResult<Readonly<Record<string, PostgresKeyStorageInfo>> | undefined> {
    if (value === undefined) return {ok: true, value: undefined};
    if (!isPlainObject(value)) return invalid(path, "Expected a key map");
    const keys: [string, PostgresKeyStorageInfo][] = [];
    for (const [key, raw] of Object.entries(value)) {
        const keyPath = childPath(path, key);
        if (!Object.hasOwn(known, key)) return invalid(keyPath, "Unknown logical key");
        const attrs = objectKeys(raw, ["name", "deferrable", "initiallyDeferred"], keyPath);
        if (!attrs.ok) return attrs;
        const name = attrs.value.name ?? null;
        if (name !== null && !isPgStoredIdentifier(name)) return invalid(childPath(keyPath, "name"), "Invalid PostgreSQL constraint name");
        const deferrable = attrs.value.deferrable === undefined ? false : attrs.value.deferrable;
        const initiallyDeferred = attrs.value.initiallyDeferred === undefined ? false : attrs.value.initiallyDeferred;
        if (typeof deferrable !== "boolean" || typeof initiallyDeferred !== "boolean" || (initiallyDeferred && !deferrable)) {
            return invalid(keyPath, "Invalid constraint timing");
        }
        keys.push([key, {name, deferrable, initiallyDeferred}]);
    }
    return {ok: true, value: Object.fromEntries(keys)};
}

function decodeObjects<T>(value: unknown, path: string, decode: (raw: unknown, path: string) => ValidationResult<T>): ValidationResult<Readonly<Record<string, T>> | undefined> {
    if (value === undefined) return {ok: true, value: undefined};
    if (!isPlainObject(value)) return invalid(path, "Expected a PostgreSQL object map");
    const entries: [string, T][] = [];
    for (const [name, raw] of Object.entries(value)) {
        const objectPath = childPath(path, name);
        if (!isPgStoredIdentifier(name)) return invalid(objectPath, "Invalid PostgreSQL object name");
        const decoded = decode(raw, objectPath);
        if (!decoded.ok) return decoded;
        entries.push([name, decoded.value]);
    }
    return {ok: true, value: Object.fromEntries(entries)};
}

function decodeCheck(value: unknown, fields: Readonly<Record<string, unknown>>, path: string): ValidationResult<PostgresCheckStorageDef> {
    const attrs = objectKeys(value, ["definition", "columns"], path);
    if (!attrs.ok) return attrs;
    const {definition, columns} = attrs.value;
    if (!isPgNonEmptyText(definition)) return invalid(childPath(path, "definition"), "Expected a CHECK definition");
    if (!Array.isArray(columns)) return invalid(childPath(path, "columns"), "Expected field references");
    const names: string[] = [];
    for (const name of columns) {
        if (typeof name !== "string" || !Object.hasOwn(fields, name) || names.includes(name)) return invalid(childPath(path, "columns"), "Unknown or repeated field reference");
        names.push(name);
    }
    return {ok: true, value: {definition, columns: names}};
}

function decodeIndex(value: unknown, path: string): ValidationResult<PostgresIndexStorageDef> {
    const attrs = objectKeys(value, ["definition"], path);
    if (!attrs.ok) return attrs;
    const definition = attrs.value.definition;
    return isPgNonEmptyText(definition) ? {ok: true, value: {definition}} : invalid(childPath(path, "definition"), "Expected a CREATE INDEX definition");
}

export function decodePostgresStorage(value: unknown, snapshot: SystemSnapshotInfo, mapping: Readonly<Record<string, PgTypeRepresentation>>): ValidationResult<PostgresStorageInfo> {
    const copied = toJsonValue(value);
    if (!copied.ok) return copied;
    const root = objectKeys(copied.value, ["entities"], "$[\"postgresStorage\"]");
    if (!root.ok) return root;
    if (!isPlainObject(root.value.entities)) return invalid("$[\"postgresStorage\"][\"entities\"]", "Expected an entity map");
    const entities: [string, PostgresStorageInfo["entities"][string]][] = [];
    for (const [entityName, raw] of Object.entries(root.value.entities)) {
        const path = childPath("$[\"postgresStorage\"][\"entities\"]", entityName);
        if (!Object.hasOwn(snapshot.entities, entityName)) return invalid(path, "Unknown entity");
        const entity = snapshot.entities[entityName];
        const attrs = objectKeys(raw, ["columns", "primaryKey", "foreignKeys", "uniqueKeys", "checks", "indexes"], path);
        if (!attrs.ok) return attrs;
        const columnsPath = childPath(path, "columns");
        const rawColumns = attrs.value.columns === undefined ? {} : attrs.value.columns;
        if (!isPlainObject(rawColumns)) return invalid(columnsPath, "Expected a column map");
        const columns: [string, PostgresColumnStorageInfo][] = [];
        for (const [name, rawColumn] of Object.entries(rawColumns)) {
            const columnPath = childPath(columnsPath, name);
            if (!Object.hasOwn(entity.fields, name)) return invalid(columnPath, "Unknown field");
            const field = entity.fields[name];
            const type = mapping[field.type];
            if (type === undefined) return invalid(columnPath, "Missing SQL type mapping");
            const column = decodeColumn(rawColumn, type, field.nullable, columnPath);
            if (!column.ok) return column;
            columns.push([name, column.value]);
        }
        const primaryKey = decodePrimaryKey(attrs.value.primaryKey, childPath(path, "primaryKey"));
        if (!primaryKey.ok) return primaryKey;
        const foreignKeys = decodeKeys(attrs.value.foreignKeys, entity.fks, childPath(path, "foreignKeys"));
        if (!foreignKeys.ok) return foreignKeys;
        const uniqueKeys = decodeKeys(attrs.value.uniqueKeys, entity.uks, childPath(path, "uniqueKeys"));
        if (!uniqueKeys.ok) return uniqueKeys;
        const checks = decodeObjects(attrs.value.checks, childPath(path, "checks"), (raw, path) => decodeCheck(raw, entity.fields, path));
        if (!checks.ok) return checks;
        const indexes = decodeObjects(attrs.value.indexes, childPath(path, "indexes"), decodeIndex);
        if (!indexes.ok) return indexes;
        entities.push([entityName, {columns: Object.fromEntries(columns), primaryKey: primaryKey.value,
            ...(foreignKeys.value === undefined ? {} : {foreignKeys: foreignKeys.value}),
            ...(uniqueKeys.value === undefined ? {} : {uniqueKeys: uniqueKeys.value}),
            ...(checks.value === undefined ? {} : {checks: checks.value}),
            ...(indexes.value === undefined ? {} : {indexes: indexes.value})}]);
    }
    return {ok: true, value: {entities: Object.fromEntries(entities)}};
}

import {childPath, isPlainObject, problem, sqlTypes, toJsonValue, type SqlType, type SystemSnapshotInfo, type ValidationResult} from "system-definition";
import type {PgTypeInfo, ProjectedPgSchemaInfo} from "./pg-schema";
import {isPgNonEmptyText} from "./pg-text";

export type PostgresIdentityMode = "byDefault" | "always";
export type PostgresColumnStorageDef = {
    typeModifiers?: readonly number[] | null;
    identity?: PostgresIdentityMode | null;
};
export type PostgresStorageDef<TSnapshot extends Pick<SystemSnapshotInfo, "entities">> = {
    entities: {readonly [E in keyof TSnapshot["entities"]]?: {
        columns?: {readonly [F in keyof TSnapshot["entities"][E]["fields"]]?: PostgresColumnStorageDef};
        primaryKey?: {name: string} | null;
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
    }>>;
};

function invalid(path: string, reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.unsupportedFormat", "blocking", {path, reason})]};
}

function objectKeys(value: unknown, keys: readonly string[], path: string): ValidationResult<Readonly<Record<string, unknown>>> {
    if (!isPlainObject(value)) return invalid(path, "Expected a PostgreSQL storage object");
    const extra = Object.keys(value).find(key => !keys.includes(key));
    return extra === undefined ? {ok: true, value} : invalid(childPath(path, extra), "Unknown PostgreSQL storage attribute");
}

/** PostgreSQL 18 type parameters; numeric(p) is printed by the catalog as numeric(p,0). */
function typeModifiers(value: unknown, type: SqlType, path: string): ValidationResult<readonly number[] | null> {
    if (value === undefined || value === null) return {ok: true, value: null};
    if (!Array.isArray(value)) return invalid(path, "Expected numeric type parameters");
    const numbers: number[] = [];
    for (const number of value) {
        if (typeof number !== "number" || !Number.isSafeInteger(number)) return invalid(path, "Type parameters must be safe integers");
        numbers.push(number);
    }
    if (numbers.length === 0) return {ok: true, value: numbers};
    const [precision, scale = 0] = numbers;
    const supported = type === sqlTypes.varchar ? numbers.length === 1 && precision >= 1 && precision <= 10_485_760
        : type === sqlTypes.numeric ? numbers.length <= 2 && precision >= 1 && precision <= 1000 && scale >= -1000 && scale <= 1000
        : [sqlTypes.time, sqlTypes.timestamp, sqlTypes.timestampWithTimeZone].some(one => one === type)
            && numbers.length === 1 && precision >= 0 && precision <= 6;
    if (!supported) return invalid(path, "Unsupported parameters for SQL type " + type);
    return {ok: true, value: type === sqlTypes.numeric ? [precision, scale] : numbers};
}

function decodeColumn(value: unknown, type: SqlType, nullable: boolean, path: string): ValidationResult<PostgresColumnStorageInfo> {
    const object = objectKeys(value, ["typeModifiers", "identity"], path);
    if (!object.ok) return object;
    const modifiers = typeModifiers(object.value.typeModifiers, type, childPath(path, "typeModifiers"));
    if (!modifiers.ok) return modifiers;
    const identity = object.value.identity ?? null;
    if (identity !== null && identity !== "byDefault" && identity !== "always") return invalid(childPath(path, "identity"), "Unknown identity mode");
    if (identity !== null && (nullable || ![sqlTypes.smallint, sqlTypes.integer, sqlTypes.bigint].some(one => one === type))) {
        return invalid(path, "An identity requires a non-nullable integer column");
    }
    return {ok: true, value: {typeModifiers: modifiers.value, identity}};
}

function decodePrimaryKey(value: unknown, path: string): ValidationResult<{name: string} | null> {
    if (value === undefined || value === null) return {ok: true, value: null};
    const object = objectKeys(value, ["name"], path);
    if (!object.ok) return object;
    const name = object.value.name;
    if (!isPgNonEmptyText(name) || new TextEncoder().encode(name).length > 63) return invalid(path, "Invalid PostgreSQL primary-key name");
    return {ok: true, value: {name}};
}

export function decodePostgresStorage(value: unknown, snapshot: SystemSnapshotInfo, mapping: Readonly<Record<string, SqlType>>): ValidationResult<PostgresStorageInfo> {
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
        const attrs = objectKeys(raw, ["columns", "primaryKey"], path);
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
        entities.push([entityName, {columns: Object.fromEntries(columns), primaryKey: primaryKey.value}]);
    }
    return {ok: true, value: {entities: Object.fromEntries(entities)}};
}

function columnType(type: PgTypeInfo, attrs: PostgresColumnStorageInfo | undefined): PgTypeInfo {
    return attrs?.typeModifiers === null || attrs?.typeModifiers === undefined ? type
        : {...type, modifiers: attrs.typeModifiers.map(String)};
}

function own<T>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
    return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Overlay physical attributes only; logical fields, nullability and key membership stay derived. */
export function applyPostgresStorage(schema: ProjectedPgSchemaInfo, storage: PostgresStorageInfo): ValidationResult<ProjectedPgSchemaInfo> {
    const objects = schema.objects.map(object => {
        const entity = object.identity.parentName === null ? undefined : own(storage.entities, object.identity.parentName);
        if (object.kind === "column") {
            const attrs = own(entity?.columns, object.identity.name);
            return {...object, type: columnType(object.type, attrs), identityDefinition: attrs?.identity === "always" ? "a"
                : attrs?.identity === "byDefault" ? "d" : object.identityDefinition};
        }
        if (object.kind === "constraint" && object.constraintKind === "primaryKey" && entity?.primaryKey) {
            return {...object, identity: {...object.identity, name: entity.primaryKey.name}};
        }
        return object;
    });
    const relations = new Set<string>();
    const constraints = new Set<string>();
    for (const object of objects) {
        if (object.kind === "constraint") {
            const key = JSON.stringify([object.identity.schema, object.identity.parentName, object.identity.name]);
            if (constraints.has(key)) return invalid("$[\"postgresStorage\"]", "Constraint name collision");
            constraints.add(key);
        }
        if (object.kind === "table" || (object.kind === "constraint" && ["primaryKey", "unique"].includes(object.constraintKind))) {
            const key = JSON.stringify([object.identity.schema, object.identity.name]);
            if (relations.has(key)) return invalid("$[\"postgresStorage\"]", "Table or backing-index name collision");
            relations.add(key);
        }
    }
    return {ok: true, value: {...schema, objects, tables: schema.tables.map(table => {
        const attrs = own(storage.entities, table.name);
        return {...table, columns: table.columns.map(column => ({...column, type: columnType(column.type, own(attrs?.columns, column.name))})),
            primaryKey: {...table.primaryKey, name: attrs?.primaryKey?.name ?? table.primaryKey.name}};
    })}};
}

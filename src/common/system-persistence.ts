import {JsonValue, toJsonValue} from "./json-value";
import {ValidationResult, problem} from "./problem";
import {AnyEntityDef} from "./ssot-entity";
import {TypeCollection} from "./ssot-types";
import {SystemSnapshotInfo} from "./system-snapshot";

export type PersistenceContext = {
    types: TypeCollection
    entities: Readonly<Record<string, AnyEntityDef>>
};

type RepresentationFor<TContext extends PersistenceContext> = {
    readonly [K in keyof TContext["types"] & string]: string
};

export type PersistenceDef<TContext extends PersistenceContext> = {
    entities: readonly (keyof TContext["entities"] & string)[]
    representations: Readonly<Record<string, RepresentationFor<TContext>>>
};

export type PersistenceInfo = {
    entities: readonly string[]
    representations: Readonly<Record<string, Readonly<Record<string, string>>>>
};

export type PersistenceInfoOf<
    TDef extends {
        entities: readonly string[]
        representations: Readonly<Record<string, Readonly<Record<string, string>>>>
    },
> = {
    entities: readonly TDef["entities"][number][]
    representations: TDef["representations"]
};

type JsonObject = {readonly [key: string]: JsonValue};

type PersistenceResult<T> = ValidationResult<T>;

function invalidPersistence(path: string, reason: string): PersistenceResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.unsupportedFormat", "blocking", {path, reason})],
    };
}

function invalidReference(path: string, reason: string): PersistenceResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidReference", "blocking", {path, reason})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
    return path + "[" + JSON.stringify(key) + "]";
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): PersistenceResult<true> {
    const actual = Object.keys(value);
    const expectedSet = new Set(expected);
    const unexpected = actual.find(key => !expectedSet.has(key));
    if (unexpected !== undefined) {
        return invalidPersistence(childPath(path, unexpected), "unexpected property");
    }
    const missing = expected.find(key => !Object.prototype.hasOwnProperty.call(value, key));
    if (missing !== undefined) {
        return invalidPersistence(childPath(path, missing), "missing property");
    }
    return {ok: true, value: true};
}

function compareUtf16(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function decodeEntities(
    value: JsonValue,
    knownEntities: ReadonlySet<string>,
    fkTargets: (entityName: string) => readonly string[],
): PersistenceResult<readonly string[]> {
    const path = "$[\"entities\"]";
    if (!Array.isArray(value)) return invalidPersistence(path, "expected an array of entity names");

    const entities: string[] = [];
    const selected = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const rawName = value[index];
        const itemPath = path + "[" + index + "]";
        if (typeof rawName !== "string") return invalidPersistence(itemPath, "expected an entity name");
        if (!knownEntities.has(rawName)) {
            return invalidReference(itemPath, "unknown entity " + JSON.stringify(rawName));
        }
        if (selected.has(rawName)) {
            return invalidPersistence(itemPath, "entity selection must not contain duplicates");
        }
        selected.add(rawName);
        entities.push(rawName);
    }

    for (const entityName of entities) {
        for (const targetName of fkTargets(entityName)) {
            if (!selected.has(targetName)) {
                return invalidReference(
                    path,
                    "entity " + JSON.stringify(entityName) + " requires fk target " + JSON.stringify(targetName) + " to be selected",
                );
            }
        }
    }

    entities.sort(compareUtf16);
    return {ok: true, value: entities};
}

function decodeRepresentations(
    value: JsonValue,
    expectedTypeNames: readonly string[],
): PersistenceResult<Readonly<Record<string, Readonly<Record<string, string>>>>> {
    const path = "$[\"representations\"]";
    if (!isObject(value)) return invalidPersistence(path, "expected a representation map");

    const expectedSet = new Set(expectedTypeNames);
    const result: Record<string, Readonly<Record<string, string>>> = Object.create(null) as Record<string, Readonly<Record<string, string>>>;

    for (const [representationName, rawMapping] of Object.entries(value)) {
        const representationPath = childPath(path, representationName);
        if (!isObject(rawMapping)) {
            return invalidPersistence(representationPath, "expected a type mapping");
        }

        const mappingKeys = Object.keys(rawMapping);
        const extra = mappingKeys.find(typeName => !expectedSet.has(typeName));
        if (extra !== undefined) {
            return invalidReference(childPath(representationPath, extra), "unknown type " + JSON.stringify(extra));
        }
        const missing = expectedTypeNames.find(typeName => !Object.prototype.hasOwnProperty.call(rawMapping, typeName));
        if (missing !== undefined) {
            return invalidReference(childPath(representationPath, missing), "missing type mapping " + JSON.stringify(missing));
        }

        const mapping: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const typeName of expectedTypeNames) {
            const physicalType = rawMapping[typeName];
            if (typeof physicalType !== "string") {
                return invalidPersistence(childPath(representationPath, typeName), "expected a physical type name string");
            }
            mapping[typeName] = physicalType;
        }
        result[representationName] = mapping;
    }

    return {ok: true, value: result};
}

function decodeCopiedPersistence(
    value: JsonValue,
    knownEntities: readonly string[],
    typeNames: readonly string[],
    fkTargets: (entityName: string) => readonly string[],
): PersistenceResult<PersistenceInfo> {
    if (!isObject(value)) return invalidPersistence("$", "expected a persistence object");
    const shape = exactKeys(value, ["entities", "representations"], "$");
    if (!shape.ok) return shape;

    if (new Set(typeNames).size !== typeNames.length) {
        return invalidPersistence("$[\"representations\"]", "type names must not repeat");
    }

    const entities = decodeEntities(value.entities, new Set(knownEntities), fkTargets);
    if (!entities.ok) return entities;
    const representations = decodeRepresentations(value.representations, typeNames);
    if (!representations.ok) return representations;

    return {
        ok: true,
        value: {
            entities: entities.value,
            representations: representations.value,
        },
    };
}

export function definePersistence<
    const TContext extends PersistenceContext,
    const TEntities extends readonly (keyof TContext["entities"] & string)[],
    const TRepresentations extends Readonly<Record<string, Readonly<Record<string, string>>>>,
>(
    _context: TContext,
    def: {
        entities: TEntities;
        representations: TRepresentations & {
            readonly [R in keyof TRepresentations]:
                NoInfer<TRepresentations[R]> extends {readonly [K in keyof TContext["types"] & string]: string}
                    ? TRepresentations[R] & Record<Exclude<keyof TRepresentations[R], keyof TContext["types"]>, never>
                    : never;
        };
    },
): {entities: TEntities, representations: TRepresentations} {
    return def;
}

export function completePersistence<
    const TContext extends PersistenceContext,
    const TEntities extends readonly (keyof TContext["entities"] & string)[],
    const TRepresentations extends Readonly<Record<string, Readonly<Record<string, string>>>>,
>(
    context: TContext,
    def: {
        entities: TEntities;
        representations: TRepresentations & {
            readonly [R in keyof TRepresentations]:
                NoInfer<TRepresentations[R]> extends {readonly [K in keyof TContext["types"] & string]: string}
                    ? TRepresentations[R] & Record<Exclude<keyof TRepresentations[R], keyof TContext["types"]>, never>
                    : never;
        };
    },
): ValidationResult<PersistenceInfoOf<{entities: TEntities, representations: TRepresentations}>> {
    const copied = toJsonValue(def);
    if (!copied.ok) return copied;

    const entityNames = Object.keys(context.entities);
    const typeNames = Object.keys(context.types);
    const decoded = decodeCopiedPersistence(
        copied.value,
        entityNames,
        typeNames,
        entityName => Object.values(context.entities[entityName]?.fks ?? {}).map(fk => fk.entity),
    );
    return decoded as ValidationResult<PersistenceInfoOf<{entities: TEntities, representations: TRepresentations}>>;
}

export function decodePersistence(
    value: unknown,
    snapshot: SystemSnapshotInfo,
): ValidationResult<PersistenceInfo> {
    const copied = toJsonValue(value);
    if (!copied.ok) return copied;

    return decodeCopiedPersistence(
        copied.value,
        Object.keys(snapshot.entities),
        snapshot.typeNames,
        entityName => Object.values(snapshot.entities[entityName]?.fks ?? {}).map(fk => fk.entity),
    );
}

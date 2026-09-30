import {
    type JsonValue,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
    type ValidationResult,
    problem,
    toJsonValue,
} from "system-definition";

export type SnapshotSide = "from" | "to";

export type FieldRefInfo = {
    side: SnapshotSide;
    entity: string;
    field: string;
};

export type DomainRefInfo = {
    side: SnapshotSide;
    type: string;
    nullable: boolean;
};

export type PortInfo = {
    domain: DomainRefInfo;
    field: FieldRefInfo | null;
};

export type MachineValueInfo = {
    domain: DomainRefInfo;
    value: string | null;
};

export type QueryRefInfo = {
    name: string;
    kind: "query";
    contentHash: string;
};

export type SourceSelectionInfo = {
    query: QueryRefInfo;
    ports: Readonly<Record<string, PortInfo>>;
    identity: readonly string[];
    coverageChecks: readonly ResourceRefInfo[];
};

export type TransformationInfo = {
    name: string;
    version: string;
    inputs: Readonly<Record<string, PortInfo>>;
    parameters: Readonly<Record<string, DomainRefInfo>>;
    outputs: Readonly<Record<string, PortInfo>>;
    mode: "row" | "set";
    query: QueryRefInfo;
    lineage: QueryRefInfo | null;
    before: readonly ResourceRefInfo[];
    after: readonly ResourceRefInfo[];
};

export type OutputBindingInfo = {
    output: string;
    target: FieldRefInfo;
};

export type MatchPairInfo = {
    output: string;
    targetField: string;
};

export type WriteInfo =
    | {
        kind: "insert";
        entity: string;
        values: readonly OutputBindingInfo[];
        key: readonly string[];
    }
    | {
        kind: "update";
        entity: string;
        values: readonly OutputBindingInfo[];
        match: readonly MatchPairInfo[];
        whenMissing: "error" | "insert";
    };

export type DataMigrationInfo = {
    id: string;
    description: string;
    dependsOn: readonly string[];
    source: SourceSelectionInfo;
    transformation: string;
    arguments: Readonly<Record<string, MachineValueInfo>>;
    writes: readonly WriteInfo[];
    conservationChecks: readonly ResourceRefInfo[];
};

export type TransformationDef = {
    name: string;
    version: string;
    inputs: Readonly<Record<string, PortInfo>>;
    parameters: Readonly<Record<string, DomainRefInfo>>;
    outputs: Readonly<Record<string, PortInfo>>;
    mode: "row" | "set";
    query: QueryRefInfo;
    lineage?: QueryRefInfo | null;
    before?: readonly ResourceRefInfo[];
    after?: readonly ResourceRefInfo[];
};

export type AuthoringContext = {
    from: SystemSnapshotInfo;
    to: SystemSnapshotInfo;
    transformations: Readonly<Record<string, TransformationInfo>>;
};

export type DataMigrationDef<C extends AuthoringContext = AuthoringContext> = {
    id: string;
    description?: string;
    dependsOn?: readonly string[];
    source: {
        query: QueryRefInfo;
        ports: Readonly<Record<string, PortInfo>>;
        identity: readonly string[];
        coverageChecks?: readonly ResourceRefInfo[];
    };
    transformation: keyof C["transformations"] & string;
    arguments: Readonly<Record<string, MachineValueInfo>>;
    writes: readonly WriteInfo[];
    conservationChecks?: readonly ResourceRefInfo[];
};

export type TransformationInfoOf<D extends TransformationDef> = TransformationInfo & {
    name: D["name"];
    version: D["version"];
};

export type DataMigrationInfoOf<
    C extends AuthoringContext,
    D extends DataMigrationDef<C>,
> = DataMigrationInfo & {
    id: D["id"];
    transformation: D["transformation"];
};

export type FieldRefsOf<
    S extends SystemSnapshotInfo,
    Side extends SnapshotSide,
> = {
    [E in keyof S["entities"] & string]: {
        [F in keyof S["entities"][E]["fields"] & string]: {
            side: Side;
            entity: E;
            field: F;
        }
    }[keyof S["entities"][E]["fields"] & string]
}[keyof S["entities"] & string];

type ExactDomain<D extends DomainRefInfo> = D &
    Record<Exclude<keyof D, keyof DomainRefInfo>, never>;

type ExactFieldRef<F extends FieldRefInfo> = F &
    Record<Exclude<keyof F, keyof FieldRefInfo>, never>;

type ExactPort<P extends PortInfo> = P &
    Record<Exclude<keyof P, keyof PortInfo>, never> & {
        domain: ExactDomain<P["domain"]>;
        field: P["field"] extends FieldRefInfo ? ExactFieldRef<P["field"]> : null;
    };

type ExactPortMap<P extends Readonly<Record<string, PortInfo>>> = {
    readonly [K in keyof P]: ExactPort<P[K]>;
};

type ExactDomainMap<D extends Readonly<Record<string, DomainRefInfo>>> = {
    readonly [K in keyof D]: ExactDomain<D[K]>;
};

type ExactQueryRef<Q extends QueryRefInfo> = Q &
    Record<Exclude<keyof Q, keyof QueryRefInfo>, never>;

type ExactMachineValue<M extends MachineValueInfo> = M &
    Record<Exclude<keyof M, keyof MachineValueInfo>, never> & {
        domain: ExactDomain<M["domain"]>;
    };

type ExactMachineValueMap<M extends Readonly<Record<string, MachineValueInfo>>> = {
    readonly [K in keyof M]: ExactMachineValue<M[K]>;
};

type ExactOutputBinding<B extends OutputBindingInfo> = B &
    Record<Exclude<keyof B, keyof OutputBindingInfo>, never> & {
        target: ExactFieldRef<B["target"]>;
    };

type ExactMatchPair<M extends MatchPairInfo> = M &
    Record<Exclude<keyof M, keyof MatchPairInfo>, never>;

type ExactWrite<W extends WriteInfo> = W extends Extract<WriteInfo, {kind: "insert"}>
    ? W & Record<Exclude<keyof W, keyof Extract<WriteInfo, {kind: "insert"}>>, never> & {
        values: {readonly [I in keyof W["values"]]: W["values"][I] extends OutputBindingInfo
            ? ExactOutputBinding<W["values"][I]>
            : W["values"][I]};
    }
    : W extends Extract<WriteInfo, {kind: "update"}>
        ? W & Record<Exclude<keyof W, keyof Extract<WriteInfo, {kind: "update"}>>, never> & {
            values: {readonly [I in keyof W["values"]]: W["values"][I] extends OutputBindingInfo
                ? ExactOutputBinding<W["values"][I]>
                : W["values"][I]};
            match: {readonly [I in keyof W["match"]]: W["match"][I] extends MatchPairInfo
                ? ExactMatchPair<W["match"][I]>
                : W["match"][I]};
        }
        : never;

type ExactWrites<W extends readonly WriteInfo[]> = {
    readonly [I in keyof W]: W[I] extends WriteInfo ? ExactWrite<W[I]> : W[I];
};

export type ExactTransformationDef<D extends TransformationDef> = D &
    Record<Exclude<keyof D, keyof TransformationDef>, never> & {
        inputs: ExactPortMap<D["inputs"]>;
        parameters: ExactDomainMap<D["parameters"]>;
        outputs: ExactPortMap<D["outputs"]>;
        query: ExactQueryRef<D["query"]>;
        lineage?: D["lineage"] extends QueryRefInfo ? ExactQueryRef<D["lineage"]> : D["lineage"];
    };

export type ExactDataMigrationDef<
    C extends AuthoringContext,
    D extends DataMigrationDef<C>,
> = D & Record<Exclude<keyof D, keyof DataMigrationDef<C>>, never> & {
    source: D["source"] &
        Record<Exclude<keyof D["source"], "query" | "ports" | "identity" | "coverageChecks">, never> & {
            query: ExactQueryRef<D["source"]["query"]>;
            ports: ExactPortMap<D["source"]["ports"]>;
        };
    arguments: ExactMachineValueMap<D["arguments"]>;
    writes: ExactWrites<D["writes"]>;
};

type SelectedTransformation<
    C extends AuthoringContext,
    D extends DataMigrationDef<C>,
> = C["transformations"][D["transformation"]];

type CompatibleSourceDomain<
    S extends DomainRefInfo,
    I extends DomainRefInfo,
> = S["side"] extends I["side"]
    ? S["type"] extends I["type"]
        ? S["nullable"] extends true
            ? I["nullable"] extends true ? S : never
            : S
        : never
    : never;

type CompatibleSourcePort<
    C extends AuthoringContext,
    I extends PortInfo,
    P extends PortInfo,
> = P & {
    domain: CompatibleSourceDomain<P["domain"], I["domain"]>;
    field: P["field"] extends null
        ? null
        : P["field"] extends FieldRefsOf<C["from"], "from"> ? P["field"] : never;
};

type CompatibleSourcePorts<
    C extends AuthoringContext,
    T extends TransformationInfo,
    P extends Readonly<Record<string, PortInfo>>,
> = {
    readonly [K in keyof T["inputs"]]: K extends keyof P
        ? P[K] extends PortInfo ? CompatibleSourcePort<C, T["inputs"][K], P[K]> : never
        : never;
} & Record<Exclude<keyof P, keyof T["inputs"]>, never>;

type CompatibleArgument<
    P extends DomainRefInfo,
    A extends MachineValueInfo,
> = A & {domain: A["domain"] extends P ? A["domain"] : never} &
    (A["value"] extends null ? (P["nullable"] extends true ? unknown : never) : unknown);

type CompatibleArguments<
    T extends TransformationInfo,
    A extends Readonly<Record<string, MachineValueInfo>>,
> = {
    readonly [K in keyof T["parameters"]]: K extends keyof A
        ? A[K] extends MachineValueInfo ? CompatibleArgument<T["parameters"][K], A[K]> : never
        : never;
} & Record<Exclude<keyof A, keyof T["parameters"]>, never>;

type ToEntityName<C extends AuthoringContext> = keyof C["to"]["entities"] & string;

type ToFieldName<
    C extends AuthoringContext,
    E extends ToEntityName<C>,
> = keyof C["to"]["entities"][E]["fields"] & string;

type OutputCompatibleWithField<
    O extends DomainRefInfo,
    F extends {type: string; nullable: boolean},
> = O["side"] extends "to"
    ? O["type"] extends F["type"]
        ? O["nullable"] extends true
            ? F["nullable"] extends true ? true : false
            : true
        : false
    : false;

type CompatibleTargetFieldNames<
    C extends AuthoringContext,
    E extends ToEntityName<C>,
    O extends DomainRefInfo,
> = {
    [F in ToFieldName<C, E>]: C["to"]["entities"][E]["fields"][F] extends {type: string; nullable: boolean}
        ? OutputCompatibleWithField<O, C["to"]["entities"][E]["fields"][F]> extends true ? F : never
        : never;
}[ToFieldName<C, E>];

type CompatibleBinding<
    C extends AuthoringContext,
    T extends TransformationInfo,
    E extends ToEntityName<C>,
    B extends OutputBindingInfo,
> = B["output"] extends keyof T["outputs"] & string
    ? B & {
        output: B["output"];
        target: B["target"] & {
            side: "to";
            entity: E;
            field: B["target"]["field"] extends CompatibleTargetFieldNames<C, E, T["outputs"][B["output"]]["domain"]>
                ? B["target"]["field"]
                : never;
        };
    }
    : never;

type CompatibleMatch<
    C extends AuthoringContext,
    T extends TransformationInfo,
    E extends ToEntityName<C>,
    M extends MatchPairInfo,
> = M["output"] extends keyof T["outputs"] & string
    ? M & {
        targetField: M["targetField"] extends CompatibleTargetFieldNames<C, E, T["outputs"][M["output"]]["domain"]>
            ? M["targetField"]
            : never;
    }
    : never;

type CompatibleWrite<
    C extends AuthoringContext,
    T extends TransformationInfo,
    W extends WriteInfo,
> = W["entity"] extends ToEntityName<C>
    ? W extends Extract<WriteInfo, {kind: "insert"}>
        ? W & {
            entity: W["entity"];
            values: {readonly [I in keyof W["values"]]: W["values"][I] extends OutputBindingInfo
                ? CompatibleBinding<C, T, W["entity"], W["values"][I]>
                : W["values"][I]};
            key: readonly ToFieldName<C, W["entity"]>[];
        }
        : W extends Extract<WriteInfo, {kind: "update"}>
            ? W & {
                entity: W["entity"];
                values: {readonly [I in keyof W["values"]]: W["values"][I] extends OutputBindingInfo
                    ? CompatibleBinding<C, T, W["entity"], W["values"][I]>
                    : W["values"][I]};
                match: {readonly [I in keyof W["match"]]: W["match"][I] extends MatchPairInfo
                    ? CompatibleMatch<C, T, W["entity"], W["match"][I]>
                    : W["match"][I]};
            }
            : never
    : never;

type CompatibleWrites<
    C extends AuthoringContext,
    T extends TransformationInfo,
    W extends readonly WriteInfo[],
> = {readonly [I in keyof W]: W[I] extends WriteInfo ? CompatibleWrite<C, T, W[I]> : W[I]};

export type CompatibleDataMigration<
    C extends AuthoringContext,
    D extends DataMigrationDef<C>,
> = D & {
    source: D["source"] & {
        ports: CompatibleSourcePorts<C, SelectedTransformation<C, D>, D["source"]["ports"]>;
        identity: readonly (keyof SelectedTransformation<C, D>["inputs"] & string)[];
    };
    arguments: CompatibleArguments<SelectedTransformation<C, D>, D["arguments"]>;
    writes: CompatibleWrites<C, SelectedTransformation<C, D>, D["writes"]>;
};

type JsonObject = {readonly [key: string]: JsonValue};

type DecodeResult<T> = ValidationResult<T>;

function invalid(path: string, reason: string): DecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.authoringInvalid", "blocking", {path, reason})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
    return path + "[" + JSON.stringify(key) + "]";
}

function exactKeys(
    value: JsonObject,
    required: readonly string[],
    optional: readonly string[],
    path: string,
): DecodeResult<true> {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) return invalid(childPath(path, key), "unexpected property");
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return invalid(childPath(path, key), "missing property");
        }
    }
    return {ok: true, value: true};
}

function nonEmptyString(value: JsonValue | undefined, path: string): DecodeResult<string> {
    if (typeof value !== "string" || value.length === 0) {
        return invalid(path, "expected a non-empty string");
    }
    return {ok: true, value};
}

function stringValue(value: JsonValue | undefined, path: string): DecodeResult<string> {
    if (typeof value !== "string") return invalid(path, "expected a string");
    return {ok: true, value};
}

function stringArray(value: JsonValue | undefined, path: string): DecodeResult<readonly string[]> {
    if (!Array.isArray(value)) return invalid(path, "expected an array of strings");
    const result: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const one = value[index];
        if (typeof one !== "string" || one.length === 0) {
            return invalid(path + "[" + index + "]", "expected a non-empty string");
        }
        if (seen.has(one)) return invalid(path + "[" + index + "]", "duplicate value");
        seen.add(one);
        result.push(one);
    }
    return {ok: true, value: result};
}

function snapshotFor(context: AuthoringContext, side: SnapshotSide): SystemSnapshotInfo {
    return side === "from" ? context.from : context.to;
}

function decodeSide(value: JsonValue | undefined, path: string): DecodeResult<SnapshotSide> {
    if (value !== "from" && value !== "to") return invalid(path, "expected from or to");
    return {ok: true, value};
}

function decodeFieldRef(
    context: AuthoringContext,
    value: JsonValue | undefined,
    path: string,
    requiredSide?: SnapshotSide,
    requiredEntity?: string,
): DecodeResult<FieldRefInfo> {
    if (!isObject(value as JsonValue)) return invalid(path, "expected a field reference");
    const object = value as JsonObject;
    const keys = exactKeys(object, ["side", "entity", "field"], [], path);
    if (!keys.ok) return keys;
    const side = decodeSide(object.side, childPath(path, "side"));
    if (!side.ok) return side;
    if (requiredSide !== undefined && side.value !== requiredSide) {
        return invalid(childPath(path, "side"), "field reference is on the wrong snapshot side");
    }
    const entity = nonEmptyString(object.entity, childPath(path, "entity"));
    if (!entity.ok) return entity;
    if (requiredEntity !== undefined && entity.value !== requiredEntity) {
        return invalid(childPath(path, "entity"), "field reference targets the wrong entity");
    }
    const field = nonEmptyString(object.field, childPath(path, "field"));
    if (!field.ok) return field;

    const snapshot = snapshotFor(context, side.value);
    const entityInfo = snapshot.entities[entity.value];
    if (entityInfo === undefined) return invalid(childPath(path, "entity"), "unknown entity");
    if (entityInfo.fields[field.value] === undefined) return invalid(childPath(path, "field"), "unknown field");
    return {ok: true, value: {side: side.value, entity: entity.value, field: field.value}};
}

function decodeDomain(
    context: AuthoringContext,
    value: JsonValue | undefined,
    path: string,
    requiredSide?: SnapshotSide,
): DecodeResult<DomainRefInfo> {
    if (!isObject(value as JsonValue)) return invalid(path, "expected a domain reference");
    const object = value as JsonObject;
    const keys = exactKeys(object, ["side", "type", "nullable"], [], path);
    if (!keys.ok) return keys;
    const side = decodeSide(object.side, childPath(path, "side"));
    if (!side.ok) return side;
    if (requiredSide !== undefined && side.value !== requiredSide) {
        return invalid(childPath(path, "side"), "domain is on the wrong snapshot side");
    }
    const type = nonEmptyString(object.type, childPath(path, "type"));
    if (!type.ok) return type;
    if (typeof object.nullable !== "boolean") {
        return invalid(childPath(path, "nullable"), "expected a boolean");
    }
    const snapshot = snapshotFor(context, side.value);
    if (!snapshot.typeNames.includes(type.value)) {
        return invalid(childPath(path, "type"), "unknown type for snapshot side");
    }
    return {ok: true, value: {side: side.value, type: type.value, nullable: object.nullable}};
}

function sameDomain(left: DomainRefInfo, right: DomainRefInfo): boolean {
    return left.side === right.side && left.type === right.type && left.nullable === right.nullable;
}

function sourceCompatible(source: DomainRefInfo, input: DomainRefInfo): boolean {
    return source.side === input.side
        && source.type === input.type
        && (!source.nullable || input.nullable);
}

function outputCompatible(output: DomainRefInfo, target: DomainRefInfo): boolean {
    return output.side === target.side
        && output.type === target.type
        && (!output.nullable || target.nullable);
}

function fieldDomain(context: AuthoringContext, ref: FieldRefInfo): DomainRefInfo {
    const field = snapshotFor(context, ref.side).entities[ref.entity]!.fields[ref.field]!;
    return {side: ref.side, type: field.type, nullable: field.nullable};
}

function decodePort(
    context: AuthoringContext,
    value: JsonValue,
    path: string,
    role: "transformationInput" | "transformationOutput" | "source",
): DecodeResult<PortInfo> {
    if (!isObject(value)) return invalid(path, "expected a port");
    const keys = exactKeys(value, ["domain", "field"], [], path);
    if (!keys.ok) return keys;
    const expectedSide = role === "transformationOutput" ? "to" : "from";
    const domain = decodeDomain(context, value.domain, childPath(path, "domain"), expectedSide);
    if (!domain.ok) return domain;
    if (value.field === null) return {ok: true, value: {domain: domain.value, field: null}};

    const field = decodeFieldRef(context, value.field, childPath(path, "field"), expectedSide);
    if (!field.ok) return field;
    const actual = fieldDomain(context, field.value);
    if (role === "source") {
        /* A source selection may explicitly widen NOT NULL to nullable (LEFT JOIN),
           but it may never narrow a nullable historical field. */
        if (actual.side !== domain.value.side
            || actual.type !== domain.value.type
            || (actual.nullable && !domain.value.nullable)) {
            return invalid(childPath(path, "domain"), "source domain disagrees with referenced field");
        }
    } else if (!sameDomain(actual, domain.value)) {
        return invalid(childPath(path, "domain"), "domain disagrees with referenced field");
    }
    return {ok: true, value: {domain: domain.value, field: field.value}};
}

function decodePortMap(
    context: AuthoringContext,
    value: JsonValue | undefined,
    path: string,
    role: "transformationInput" | "transformationOutput" | "source",
): DecodeResult<Readonly<Record<string, PortInfo>>> {
    if (!isObject(value as JsonValue)) return invalid(path, "expected a port map");
    const result: Record<string, PortInfo> = Object.create(null) as Record<string, PortInfo>;
    for (const [name, raw] of Object.entries(value as JsonObject)) {
        if (name.length === 0 || name.startsWith("__")) {
            return invalid(childPath(path, name), "invalid port name");
        }
        const decoded = decodePort(context, raw, childPath(path, name), role);
        if (!decoded.ok) return decoded;
        result[name] = decoded.value;
    }
    return {ok: true, value: result};
}

function decodeDomainMap(
    context: AuthoringContext,
    value: JsonValue | undefined,
    path: string,
): DecodeResult<Readonly<Record<string, DomainRefInfo>>> {
    if (!isObject(value as JsonValue)) return invalid(path, "expected a domain map");
    const result: Record<string, DomainRefInfo> = Object.create(null) as Record<string, DomainRefInfo>;
    for (const [name, raw] of Object.entries(value as JsonObject)) {
        if (name.length === 0 || name.startsWith("__")) {
            return invalid(childPath(path, name), "invalid parameter name");
        }
        const decoded = decodeDomain(context, raw, childPath(path, name));
        if (!decoded.ok) return decoded;
        result[name] = decoded.value;
    }
    return {ok: true, value: result};
}

function decodeQueryRef(value: JsonValue | undefined, path: string): DecodeResult<QueryRefInfo> {
    if (!isObject(value as JsonValue)) return invalid(path, "expected a query reference");
    const object = value as JsonObject;
    const keys = exactKeys(object, ["name", "kind", "contentHash"], [], path);
    if (!keys.ok) return keys;
    const name = nonEmptyString(object.name, childPath(path, "name"));
    if (!name.ok) return name;
    if (object.kind !== "query") return invalid(childPath(path, "kind"), "expected query");
    const contentHash = nonEmptyString(object.contentHash, childPath(path, "contentHash"));
    if (!contentHash.ok) return contentHash;
    if (!/^[0-9a-f]{64}$/.test(contentHash.value)) {
        return invalid(childPath(path, "contentHash"), "expected lowercase SHA-256");
    }
    return {ok: true, value: {name: name.value, kind: "query", contentHash: contentHash.value}};
}

function decodeCheckRef(value: JsonValue, path: string): DecodeResult<ResourceRefInfo> {
    if (!isObject(value)) return invalid(path, "expected a check reference");
    const keys = exactKeys(value, ["name", "kind", "contentHash"], [], path);
    if (!keys.ok) return keys;
    const name = nonEmptyString(value.name, childPath(path, "name"));
    if (!name.ok) return name;
    if (value.kind !== "check") return invalid(childPath(path, "kind"), "expected check");
    const contentHash = nonEmptyString(value.contentHash, childPath(path, "contentHash"));
    if (!contentHash.ok) return contentHash;
    if (!/^[0-9a-f]{64}$/.test(contentHash.value)) {
        return invalid(childPath(path, "contentHash"), "expected lowercase SHA-256");
    }
    return {ok: true, value: {name: name.value, kind: "check", contentHash: contentHash.value}};
}

function decodeCheckArray(value: JsonValue | undefined, path: string): DecodeResult<readonly ResourceRefInfo[]> {
    if (!Array.isArray(value)) return invalid(path, "expected an array of check references");
    const result: ResourceRefInfo[] = [];
    for (let index = 0; index < value.length; index++) {
        const decoded = decodeCheckRef(value[index]!, path + "[" + index + "]");
        if (!decoded.ok) return decoded;
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

function decodeTransformationJson(
    context: AuthoringContext,
    value: JsonValue,
): DecodeResult<TransformationInfo> {
    const path = "$";
    if (!isObject(value)) return invalid(path, "expected a transformation object");
    const keys = exactKeys(
        value,
        ["name", "version", "inputs", "parameters", "outputs", "mode", "query"],
        ["lineage", "before", "after"],
        path,
    );
    if (!keys.ok) return keys;

    const name = nonEmptyString(value.name, "$.name");
    if (!name.ok) return name;
    const version = nonEmptyString(value.version, "$.version");
    if (!version.ok) return version;
    const inputs = decodePortMap(context, value.inputs, "$.inputs", "transformationInput");
    if (!inputs.ok) return inputs;
    const parameters = decodeDomainMap(context, value.parameters, "$.parameters");
    if (!parameters.ok) return parameters;
    const outputs = decodePortMap(context, value.outputs, "$.outputs", "transformationOutput");
    if (!outputs.ok) return outputs;
    if (value.mode !== "row" && value.mode !== "set") return invalid("$.mode", "expected row or set");
    const query = decodeQueryRef(value.query, "$.query");
    if (!query.ok) return query;

    let lineage: QueryRefInfo | null;
    if (value.mode === "set") {
        if (value.lineage === undefined || value.lineage === null) {
            return invalid("$.lineage", "set transformations require lineage");
        }
        const decoded = decodeQueryRef(value.lineage, "$.lineage");
        if (!decoded.ok) return decoded;
        lineage = decoded.value;
    } else if (value.lineage === undefined || value.lineage === null) {
        lineage = null;
    } else {
        return invalid("$.lineage", "row transformations do not declare lineage");
    }

    const before = value.before === undefined
        ? {ok: true as const, value: [] as readonly ResourceRefInfo[]}
        : decodeCheckArray(value.before, "$.before");
    if (!before.ok) return before;
    const after = value.after === undefined
        ? {ok: true as const, value: [] as readonly ResourceRefInfo[]}
        : decodeCheckArray(value.after, "$.after");
    if (!after.ok) return after;

    return {
        ok: true,
        value: {
            name: name.value,
            version: version.value,
            inputs: inputs.value,
            parameters: parameters.value,
            outputs: outputs.value,
            mode: value.mode,
            query: query.value,
            lineage,
            before: before.value,
            after: after.value,
        },
    };
}

function decodeMachineValue(
    context: AuthoringContext,
    value: JsonValue,
    path: string,
): DecodeResult<MachineValueInfo> {
    if (!isObject(value)) return invalid(path, "expected a machine value");
    const keys = exactKeys(value, ["domain", "value"], [], path);
    if (!keys.ok) return keys;
    const domain = decodeDomain(context, value.domain, childPath(path, "domain"));
    if (!domain.ok) return domain;
    if (value.value !== null && typeof value.value !== "string") {
        return invalid(childPath(path, "value"), "machine values are strings or null");
    }
    if (value.value === null && !domain.value.nullable) {
        return invalid(childPath(path, "value"), "null is not permitted by the domain");
    }
    return {ok: true, value: {domain: domain.value, value: value.value}};
}

function decodeArguments(
    context: AuthoringContext,
    value: JsonValue | undefined,
    transformation: TransformationInfo,
    path: string,
): DecodeResult<Readonly<Record<string, MachineValueInfo>>> {
    if (!isObject(value as JsonValue)) return invalid(path, "expected an argument map");
    const object = value as JsonObject;
    const expected = Object.keys(transformation.parameters);
    const actual = Object.keys(object);
    if (actual.length !== expected.length || expected.some(name => !Object.prototype.hasOwnProperty.call(object, name))) {
        return invalid(path, "argument names must exactly match transformation parameters");
    }
    const result: Record<string, MachineValueInfo> = Object.create(null) as Record<string, MachineValueInfo>;
    for (const name of expected) {
        const decoded = decodeMachineValue(context, object[name]!, childPath(path, name));
        if (!decoded.ok) return decoded;
        if (!sameDomain(decoded.value.domain, transformation.parameters[name]!)) {
            return invalid(childPath(path, name), "argument domain is incompatible with transformation parameter");
        }
        result[name] = decoded.value;
    }
    return {ok: true, value: result};
}

function decodeOutputBinding(
    context: AuthoringContext,
    value: JsonValue,
    transformation: TransformationInfo,
    entity: string,
    path: string,
): DecodeResult<OutputBindingInfo> {
    if (!isObject(value)) return invalid(path, "expected an output binding");
    const keys = exactKeys(value, ["output", "target"], [], path);
    if (!keys.ok) return keys;
    const output = nonEmptyString(value.output, childPath(path, "output"));
    if (!output.ok) return output;
    const outputPort = transformation.outputs[output.value];
    if (outputPort === undefined) return invalid(childPath(path, "output"), "unknown transformation output");
    const target = decodeFieldRef(context, value.target, childPath(path, "target"), "to", entity);
    if (!target.ok) return target;
    if (!outputCompatible(outputPort.domain, fieldDomain(context, target.value))) {
        return invalid(childPath(path, "target"), "output domain is incompatible with target field");
    }
    return {ok: true, value: {output: output.value, target: target.value}};
}

function decodeBindings(
    context: AuthoringContext,
    value: JsonValue | undefined,
    transformation: TransformationInfo,
    entity: string,
    path: string,
): DecodeResult<readonly OutputBindingInfo[]> {
    if (!Array.isArray(value)) return invalid(path, "expected an array of output bindings");
    const result: OutputBindingInfo[] = [];
    const targets = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const decoded = decodeOutputBinding(context, value[index]!, transformation, entity, path + "[" + index + "]");
        if (!decoded.ok) return decoded;
        if (targets.has(decoded.value.target.field)) {
            return invalid(path + "[" + index + "]", "duplicate target field");
        }
        targets.add(decoded.value.target.field);
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

function decodeMatch(
    context: AuthoringContext,
    value: JsonValue | undefined,
    transformation: TransformationInfo,
    entity: string,
    path: string,
): DecodeResult<readonly MatchPairInfo[]> {
    if (!Array.isArray(value)) return invalid(path, "expected a match array");
    const entityInfo = context.to.entities[entity];
    if (entityInfo === undefined) return invalid(path, "unknown destination entity");
    const result: MatchPairInfo[] = [];
    const fields = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const itemPath = path + "[" + index + "]";
        const raw = value[index]!;
        if (!isObject(raw)) return invalid(itemPath, "expected a match pair");
        const keys = exactKeys(raw, ["output", "targetField"], [], itemPath);
        if (!keys.ok) return keys;
        const output = nonEmptyString(raw.output, childPath(itemPath, "output"));
        if (!output.ok) return output;
        const port = transformation.outputs[output.value];
        if (port === undefined) return invalid(childPath(itemPath, "output"), "unknown transformation output");
        const targetField = nonEmptyString(raw.targetField, childPath(itemPath, "targetField"));
        if (!targetField.ok) return targetField;
        const targetInfo = entityInfo.fields[targetField.value];
        if (targetInfo === undefined) return invalid(childPath(itemPath, "targetField"), "unknown target field");
        const targetDomain: DomainRefInfo = {side: "to", type: targetInfo.type, nullable: targetInfo.nullable};
        if (!outputCompatible(port.domain, targetDomain)) {
            return invalid(itemPath, "match output is incompatible with target field");
        }
        if (fields.has(targetField.value)) return invalid(itemPath, "duplicate match target field");
        fields.add(targetField.value);
        result.push({output: output.value, targetField: targetField.value});
    }
    return {ok: true, value: result};
}

function decodeWrite(
    context: AuthoringContext,
    value: JsonValue,
    transformation: TransformationInfo,
    path: string,
): DecodeResult<WriteInfo> {
    if (!isObject(value)) return invalid(path, "expected a write");
    if (value.kind !== "insert" && value.kind !== "update") {
        return invalid(childPath(path, "kind"), "expected insert or update");
    }
    const required = value.kind === "insert"
        ? ["kind", "entity", "values", "key"]
        : ["kind", "entity", "values", "match", "whenMissing"];
    const keys = exactKeys(value, required, [], path);
    if (!keys.ok) return keys;
    const entity = nonEmptyString(value.entity, childPath(path, "entity"));
    if (!entity.ok) return entity;
    if (context.to.entities[entity.value] === undefined) {
        return invalid(childPath(path, "entity"), "unknown destination entity");
    }
    const values = decodeBindings(context, value.values, transformation, entity.value, childPath(path, "values"));
    if (!values.ok) return values;

    if (value.kind === "insert") {
        const key = stringArray(value.key, childPath(path, "key"));
        if (!key.ok) return key;
        for (const field of key.value) {
            if (context.to.entities[entity.value]!.fields[field] === undefined) {
                return invalid(childPath(path, "key"), "insert key names an unknown target field");
            }
        }
        return {ok: true, value: {kind: "insert", entity: entity.value, values: values.value, key: key.value}};
    }

    const match = decodeMatch(context, value.match, transformation, entity.value, childPath(path, "match"));
    if (!match.ok) return match;
    if (value.whenMissing !== "error" && value.whenMissing !== "insert") {
        return invalid(childPath(path, "whenMissing"), "expected error or insert");
    }
    return {
        ok: true,
        value: {
            kind: "update",
            entity: entity.value,
            values: values.value,
            match: match.value,
            whenMissing: value.whenMissing,
        },
    };
}

function decodeDataMigrationJson(
    context: AuthoringContext,
    value: JsonValue,
): DecodeResult<DataMigrationInfo> {
    const path = "$";
    if (!isObject(value)) return invalid(path, "expected a data migration object");
    const keys = exactKeys(
        value,
        ["id", "source", "transformation", "arguments", "writes"],
        ["description", "dependsOn", "conservationChecks"],
        path,
    );
    if (!keys.ok) return keys;
    const id = nonEmptyString(value.id, "$.id");
    if (!id.ok) return id;
    const description = value.description === undefined
        ? {ok: true as const, value: ""}
        : stringValue(value.description, "$.description");
    if (!description.ok) return description;
    const dependsOn = value.dependsOn === undefined
        ? {ok: true as const, value: [] as readonly string[]}
        : stringArray(value.dependsOn, "$.dependsOn");
    if (!dependsOn.ok) return dependsOn;
    const transformationName = nonEmptyString(value.transformation, "$.transformation");
    if (!transformationName.ok) return transformationName;
    const transformation = context.transformations[transformationName.value];
    if (transformation === undefined) return invalid("$.transformation", "unknown transformation");

    if (!isObject(value.source as JsonValue)) return invalid("$.source", "expected a source selection");
    const source = value.source as JsonObject;
    const sourceKeys = exactKeys(source, ["query", "ports", "identity"], ["coverageChecks"], "$.source");
    if (!sourceKeys.ok) return sourceKeys;
    const sourceQuery = decodeQueryRef(source.query, "$.source.query");
    if (!sourceQuery.ok) return sourceQuery;
    const ports = decodePortMap(context, source.ports, "$.source.ports", "source");
    if (!ports.ok) return ports;
    const expectedInputNames = Object.keys(transformation.inputs);
    const sourceNames = Object.keys(ports.value);
    if (sourceNames.length !== expectedInputNames.length
        || expectedInputNames.some(name => !Object.prototype.hasOwnProperty.call(ports.value, name))) {
        return invalid("$.source.ports", "source ports must exactly match transformation inputs");
    }
    for (const name of expectedInputNames) {
        if (!sourceCompatible(ports.value[name]!.domain, transformation.inputs[name]!.domain)) {
            return invalid(childPath("$.source.ports", name), "source port is incompatible with transformation input");
        }
    }
    const identity = stringArray(source.identity, "$.source.identity");
    if (!identity.ok) return identity;
    if (identity.value.length === 0) return invalid("$.source.identity", "identity must not be empty");
    for (const name of identity.value) {
        const port = ports.value[name];
        if (port === undefined) return invalid("$.source.identity", "identity names an unknown source port");
        if (port.domain.nullable) return invalid("$.source.identity", "identity ports must be non-null");
    }
    const coverageChecks = source.coverageChecks === undefined
        ? {ok: true as const, value: [] as readonly ResourceRefInfo[]}
        : decodeCheckArray(source.coverageChecks, "$.source.coverageChecks");
    if (!coverageChecks.ok) return coverageChecks;

    const argumentsResult = decodeArguments(context, value.arguments, transformation, "$.arguments");
    if (!argumentsResult.ok) return argumentsResult;

    if (!Array.isArray(value.writes)) return invalid("$.writes", "expected an array of writes");
    const writes: WriteInfo[] = [];
    for (let index = 0; index < value.writes.length; index++) {
        const decoded = decodeWrite(context, value.writes[index]!, transformation, "$.writes[" + index + "]");
        if (!decoded.ok) return decoded;
        writes.push(decoded.value);
    }

    const conservationChecks = value.conservationChecks === undefined
        ? {ok: true as const, value: [] as readonly ResourceRefInfo[]}
        : decodeCheckArray(value.conservationChecks, "$.conservationChecks");
    if (!conservationChecks.ok) return conservationChecks;

    return {
        ok: true,
        value: {
            id: id.value,
            description: description.value,
            dependsOn: dependsOn.value,
            source: {
                query: sourceQuery.value,
                ports: ports.value,
                identity: identity.value,
                coverageChecks: coverageChecks.value,
            },
            transformation: transformationName.value,
            arguments: argumentsResult.value,
            writes,
            conservationChecks: conservationChecks.value,
        },
    };
}

export function defineTransformation<const D extends TransformationDef>(
    _context: AuthoringContext,
    def: D & ExactTransformationDef<D>,
): D {
    return def;
}

export function completeTransformation<const D extends TransformationDef>(
    context: AuthoringContext,
    def: D,
): ValidationResult<TransformationInfoOf<D>> {
    const json = toJsonValue(def);
    if (!json.ok) return json;
    const decoded = decodeTransformationJson(context, json.value);
    return decoded as ValidationResult<TransformationInfoOf<D>>;
}

export function defineDataMigration<
    const C extends AuthoringContext,
    const D extends DataMigrationDef<C>,
>(
    _context: C,
    def: D & ExactDataMigrationDef<C, D> & CompatibleDataMigration<C, D>,
): D {
    return def;
}

export function completeDataMigration<
    const C extends AuthoringContext,
    const D extends DataMigrationDef<C>,
>(
    context: C,
    def: D,
): ValidationResult<DataMigrationInfoOf<C, D>> {
    const json = toJsonValue(def);
    if (!json.ok) return json;
    const decoded = decodeDataMigrationJson(context, json.value);
    return decoded as ValidationResult<DataMigrationInfoOf<C, D>>;
}

export function decodeDataMigration(
    context: AuthoringContext,
    value: unknown,
): ValidationResult<DataMigrationInfo> {
    const json = toJsonValue(value);
    if (!json.ok) return json;
    return decodeDataMigrationJson(context, json.value);
}

import {
    childPath,
    decodeArray,
    decodeContentRefInfo,
    exactOptionalKeys,
    isNonEmptyString,
    isPlainObject,
    type ContentRefInfo,
    type JsonValue,
    type ResourceRefInfo,
    type SystemSnapshotInfo,
    type ValidationResult,
    problem,
    toJsonValue,
} from "system-definition";

import {decodeDataMigrationShape, decodeDomainRefInfo, decodePortInfo} from "./data-authoring-codec";

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

export type QueryRefInfo = ContentRefInfo<"query">;

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

function invalid(path: string, reason: string): ValidationResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.authoringInvalid", "blocking", {path, reason})],
    };
}

function isObject(value: JsonValue | undefined): value is JsonObject {
    return isPlainObject(value);
}

function exactKeys(
    value: JsonObject,
    required: readonly string[],
    optional: readonly string[],
    path: string,
): ValidationResult<true> {
    return exactOptionalKeys(value, required, optional, path, invalid);
}

function nonEmptyString(value: JsonValue | undefined, path: string): ValidationResult<string> {
    if (!isNonEmptyString(value)) {
        return invalid(path, "expected a non-empty string");
    }
    return {ok: true, value};
}

function snapshotFor(context: AuthoringContext, side: SnapshotSide): SystemSnapshotInfo {
    return side === "from" ? context.from : context.to;
}

function validateFieldRef(context: AuthoringContext, ref: FieldRefInfo, path: string, side?: SnapshotSide, entity?: string): ValidationResult<FieldRefInfo> {
    if (side !== undefined && ref.side !== side) return invalid(path, "field reference is on the wrong snapshot side");
    if (entity !== undefined && ref.entity !== entity) return invalid(path, "field reference targets the wrong entity");
    const found = snapshotFor(context, ref.side).entities[ref.entity];
    if (found === undefined || found.fields[ref.field] === undefined) return invalid(path, "unknown entity or field");
    return {ok: true, value: ref};
}

function validateDomain(context: AuthoringContext, domain: DomainRefInfo, path: string, side?: SnapshotSide): ValidationResult<DomainRefInfo> {
    if (side !== undefined && domain.side !== side) return invalid(path, "domain is on the wrong snapshot side");
    if (!snapshotFor(context, domain.side).typeNames.includes(domain.type)) return invalid(path, "unknown type for snapshot side");
    return {ok: true, value: domain};
}

function decodeDomain(context: AuthoringContext, value: JsonValue | undefined, path: string): ValidationResult<DomainRefInfo> {
    const domain = decodeDomainRefInfo(value, path, invalid);
    return domain.ok ? validateDomain(context, domain.value, path) : domain;
}

export function sameDomainRef(left: DomainRefInfo, right: DomainRefInfo): boolean {
    return left.side === right.side && left.type === right.type && left.nullable === right.nullable;
}

function domainAssignable(source: DomainRefInfo, input: DomainRefInfo): boolean {
    return source.side === input.side
        && source.type === input.type
        && (!source.nullable || input.nullable);
}

function fieldDomain(context: AuthoringContext, ref: FieldRefInfo): DomainRefInfo {
    const field = snapshotFor(context, ref.side).entities[ref.entity]!.fields[ref.field]!;
    return {side: ref.side, type: field.type, nullable: field.nullable};
}

function validatePort(context: AuthoringContext, port: PortInfo, path: string, role: "transformationInput" | "transformationOutput" | "source"): ValidationResult<PortInfo> {
    const side = role === "transformationOutput" ? "to" : "from";
    const domain = validateDomain(context, port.domain, path + ".domain", side); if (!domain.ok) return domain;
    if (port.field !== null) {
        const field = validateFieldRef(context, port.field, path + ".field", side); if (!field.ok) return field;
        const actual = fieldDomain(context, field.value);
        // LEFT JOIN sources can widen nullability; transformation ports must match exactly.
        if (!(role === "source" ? domainAssignable(actual, port.domain) : sameDomainRef(actual, port.domain))) return invalid(path + ".domain", "domain disagrees with referenced field");
    }
    return {ok: true, value: port};
}

function decodePort(context: AuthoringContext, value: JsonValue, path: string, role: "transformationInput" | "transformationOutput" | "source"): ValidationResult<PortInfo> {
    const port = decodePortInfo(value, path, invalid);
    return port.ok ? validatePort(context, port.value, path, role) : port;
}

export function decodeValidationPorts(context: AuthoringContext, value: unknown, side: SnapshotSide): ValidationResult<Readonly<Record<string, PortInfo>>> {
    const json = toJsonValue(value);
    if (!json.ok) return json;
    return decodePortMap(context, json.value, "$", side === "from" ? "source" : "transformationOutput");
}

function decodePortMap(
    context: AuthoringContext,
    value: JsonValue | undefined,
    path: string,
    role: "transformationInput" | "transformationOutput" | "source",
): ValidationResult<Readonly<Record<string, PortInfo>>> {
    if (!isObject(value)) return invalid(path, "expected a port map");
    const result: Record<string, PortInfo> = Object.create(null) as Record<string, PortInfo>;
    for (const [name, raw] of Object.entries(value)) {
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
): ValidationResult<Readonly<Record<string, DomainRefInfo>>> {
    if (!isObject(value)) return invalid(path, "expected a domain map");
    const result: Record<string, DomainRefInfo> = Object.create(null) as Record<string, DomainRefInfo>;
    for (const [name, raw] of Object.entries(value)) {
        if (name.length === 0 || name.startsWith("__")) {
            return invalid(childPath(path, name), "invalid parameter name");
        }
        const decoded = decodeDomain(context, raw, childPath(path, name));
        if (!decoded.ok) return decoded;
        result[name] = decoded.value;
    }
    return {ok: true, value: result};
}

function decodeQueryRef(value: JsonValue | undefined, path: string): ValidationResult<QueryRefInfo> {
    return decodeContentRefInfo(value, path, "query", invalid);
}

function decodeCheckArray(value: JsonValue | undefined, path: string): ValidationResult<readonly ResourceRefInfo[]> {
    return decodeArray(value, path, invalid, (raw, at) => decodeContentRefInfo(raw, at, "check", invalid));
}

function decodeTransformationJson(
    context: AuthoringContext,
    value: JsonValue,
): ValidationResult<TransformationInfo> {
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

function decodeDataMigrationJson(context: AuthoringContext, value: JsonValue): ValidationResult<DataMigrationInfo> {
    const decoded = decodeDataMigrationShape(value, "$", invalid);
    if (!decoded.ok) return decoded;
    const migration = decoded.value;
    const transformation = context.transformations[migration.transformation];
    if (transformation === undefined) return invalid("$.transformation", "unknown transformation");
    const {source} = migration;
    const inputNames = Object.keys(transformation.inputs);
    if (Object.keys(source.ports).length !== inputNames.length || inputNames.some(name => !Object.hasOwn(source.ports, name))) return invalid("$.source.ports", "source ports must exactly match transformation inputs");
    for (const [name, port] of Object.entries(source.ports)) {
        const valid = validatePort(context, port, childPath("$.source.ports", name), "source"); if (!valid.ok) return valid;
        if (!domainAssignable(port.domain, transformation.inputs[name]!.domain)) return invalid(childPath("$.source.ports", name), "source port is incompatible with transformation input");
    }
    if (source.identity.length === 0) return invalid("$.source.identity", "identity must not be empty");
    for (const name of source.identity) {
        const port = source.ports[name];
        if (port === undefined || port.domain.nullable) return invalid("$.source.identity", "identity must name non-null source ports");
    }
    const parameterNames = Object.keys(transformation.parameters);
    if (Object.keys(migration.arguments).length !== parameterNames.length || parameterNames.some(name => !Object.hasOwn(migration.arguments, name))) return invalid("$.arguments", "argument names must exactly match transformation parameters");
    for (const [name, argument] of Object.entries(migration.arguments)) {
        const at = childPath("$.arguments", name);
        const domain = validateDomain(context, argument.domain, at); if (!domain.ok) return domain;
        if (argument.value === null && !argument.domain.nullable) return invalid(at, "null is not permitted by the domain");
        if (!sameDomainRef(argument.domain, transformation.parameters[name]!)) return invalid(at, "argument domain is incompatible with transformation parameter");
    }
    for (const [index, write] of migration.writes.entries()) {
        const at = "$.writes[" + index + "]";
        const entity = context.to.entities[write.entity];
        if (entity === undefined) return invalid(at, "unknown destination entity");
        const targets = new Set<string>();
        for (const binding of write.values) {
            const output = transformation.outputs[binding.output];
            if (output === undefined) return invalid(at, "unknown transformation output");
            const target = validateFieldRef(context, binding.target, at, "to", write.entity); if (!target.ok) return target;
            if (!domainAssignable(output.domain, fieldDomain(context, target.value))) return invalid(at, "output domain is incompatible with target field");
            if (targets.has(binding.target.field)) return invalid(at, "duplicate target field");
            targets.add(binding.target.field);
        }
        if (write.kind === "insert") {
            if (write.key.some(name => entity.fields[name] === undefined)) return invalid(at, "insert key names an unknown target field");
        } else {
            const matched = new Set<string>();
            for (const pair of write.match) {
                const output = transformation.outputs[pair.output], field = entity.fields[pair.targetField];
                if (output === undefined || field === undefined) return invalid(at, "unknown match output or target field");
                if (!domainAssignable(output.domain, {side: "to", type: field.type, nullable: field.nullable})) return invalid(at, "match output is incompatible with target field");
                if (matched.has(pair.targetField)) return invalid(at, "duplicate match target field");
                matched.add(pair.targetField);
            }
        }
    }
    return decoded;
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

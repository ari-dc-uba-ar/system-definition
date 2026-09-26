import {ValidationResult, problem} from "./problem";
import {JsonValue, toJsonValue} from "./json-value";

export type FileInfo = {
    path: string;
    contentHash: string;
    byteLength: number;
};

export type ReleaseRefInfo = {
    systemId: string;
    releaseId: string;
    releaseHash: string;
};

export type ResourceInfo = {
    kind: "sql" | "check";
    file: FileInfo;
};

export type ResourceRefInfo = {
    name: string;
    kind: "sql" | "check";
    contentHash: string;
};

export type MigrationContext = {
    releases: Readonly<Record<string, ReleaseRefInfo>>;
    resources: Readonly<Record<string, ResourceInfo>>;
};

export type ResourceNamesFor<
    TContext extends MigrationContext,
    TKind extends ResourceInfo["kind"],
> = {
    [N in keyof TContext["resources"]]:
        TContext["resources"][N]["kind"] extends TKind ? N : never
}[keyof TContext["resources"]] & string;

export type MigrationDef<TContext extends MigrationContext> = {
    id: string;
    from: keyof TContext["releases"] & string;
    to: keyof TContext["releases"] & string;
    description?: string;
    before?: readonly ResourceNamesFor<TContext, "check">[];
    steps: readonly {
        id: string;
        run: ResourceNamesFor<TContext, "sql">;
    }[];
    after?: readonly ResourceNamesFor<TContext, "check">[];
};

export type ExactMigrationDef<
    TContext extends MigrationContext,
    TDef extends MigrationDef<TContext>,
> = Record<Exclude<keyof NoInfer<TDef>, keyof MigrationDef<TContext>>, never>
    & {
        steps: TDef["steps"] & {
            readonly [I in keyof TDef["steps"]]: TDef["steps"][I] extends {id: string, run: string}
                ? TDef["steps"][I] & Record<Exclude<keyof NoInfer<TDef["steps"][I]>, "id" | "run">, never>
                : TDef["steps"][I];
        };
    };

export type MigrationInfo = {
    id: string;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    description: string;
    before: readonly ResourceRefInfo[];
    steps: readonly {id: string, run: ResourceRefInfo}[];
    after: readonly ResourceRefInfo[];
};

type ResourceRefFor<
    TContext extends MigrationContext,
    TName extends keyof TContext["resources"] & string,
> = {
    name: TName;
    kind: TContext["resources"][TName]["kind"];
    contentHash: TContext["resources"][TName]["file"]["contentHash"];
};

type ResourceRefsFor<
    TContext extends MigrationContext,
    TNames extends readonly (keyof TContext["resources"] & string)[],
> = {
    readonly [I in keyof TNames]: TNames[I] extends keyof TContext["resources"] & string
        ? ResourceRefFor<TContext, TNames[I]>
        : never;
};

type StepsInfoFor<
    TContext extends MigrationContext,
    TSteps extends readonly {id: string, run: keyof TContext["resources"] & string}[],
> = {
    readonly [I in keyof TSteps]: TSteps[I] extends {
        id: infer TId extends string,
        run: infer TRun extends keyof TContext["resources"] & string,
    }
        ? {id: TId, run: ResourceRefFor<TContext, TRun>}
        : never;
};

export type MigrationInfoOf<
    TContext extends MigrationContext,
    TDef extends MigrationDef<TContext>,
> = {
    id: TDef["id"];
    from: TContext["releases"][TDef["from"]];
    to: TContext["releases"][TDef["to"]];
    description: TDef extends {description: infer TDescription extends string} ? TDescription : "";
    before: TDef extends {before: infer TBefore extends readonly ResourceNamesFor<TContext, "check">[]}
        ? ResourceRefsFor<TContext, TBefore>
        : readonly [];
    steps: StepsInfoFor<TContext, TDef["steps"]>;
    after: TDef extends {after: infer TAfter extends readonly ResourceNamesFor<TContext, "check">[]}
        ? ResourceRefsFor<TContext, TAfter>
        : readonly [];
};

export function defineMigration<
    const TContext extends MigrationContext,
    const TDef extends MigrationDef<TContext>,
>(
    _context: TContext,
    def: TDef & ExactMigrationDef<TContext, TDef>,
): TDef {
    return def;
}

export function defineMigrations<
    const TContext extends MigrationContext,
    const TDefs extends Readonly<Record<string, MigrationDef<TContext>>>,
>(
    _context: TContext,
    defs: TDefs & {
        readonly [K in keyof TDefs]: TDefs[K]
            & ExactMigrationDef<TContext, TDefs[K]>
            & {id: K & string};
    },
): TDefs {
    return defs;
}

type DecodeResult<T> = ValidationResult<T>;

type JsonObject = {readonly [key: string]: JsonValue};

function invalidJson(path: string, reason: string): DecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidJson", "blocking", {path, reason})],
    };
}

function invalidReference(path: string, reason: string): DecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidReference", "blocking", {path, reason})],
    };
}

function invalidResourceKind(path: string, expected: ResourceInfo["kind"], actual: string): DecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidResourceKind", "blocking", {path, expected, actual})],
    };
}

function invalidCatalog(path: string, reason: string): DecodeResult<never> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidCatalog", "blocking", {path, reason})],
    };
}

function isObject(value: JsonValue): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
    return path + "[" + JSON.stringify(key) + "]";
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): DecodeResult<true> {
    const allowed = new Set(keys);
    const actual = Object.keys(value);
    for (const key of actual) {
        if (!allowed.has(key)) return invalidJson(childPath(path, key), "unexpected property");
    }
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return invalidJson(childPath(path, key), "missing property");
        }
    }
    return {ok: true, value: true};
}

function exactOptionalKeys(
    value: JsonObject,
    required: readonly string[],
    optional: readonly string[],
    path: string,
): DecodeResult<true> {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) return invalidJson(childPath(path, key), "unexpected property");
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return invalidJson(childPath(path, key), "missing property");
        }
    }
    return {ok: true, value: true};
}

function nonEmptyString(value: JsonValue, path: string, label: string): DecodeResult<string> {
    if (typeof value !== "string") return invalidJson(path, "expected a string");
    if (value.trim().length === 0) return invalidJson(path, label + " must not be empty");
    return {ok: true, value};
}

function copyRelease(reference: ReleaseRefInfo): ReleaseRefInfo {
    return {
        systemId: reference.systemId,
        releaseId: reference.releaseId,
        releaseHash: reference.releaseHash,
    };
}

function resourceRef(name: string, expectedKind: ResourceInfo["kind"], context: MigrationContext, path: string): DecodeResult<ResourceRefInfo> {
    const resource = context.resources[name];
    if (resource === undefined) {
        return invalidReference(path, "unknown resource " + JSON.stringify(name));
    }
    if (resource.kind !== expectedKind) {
        return invalidResourceKind(path, expectedKind, resource.kind);
    }
    return {
        ok: true,
        value: {name, kind: resource.kind, contentHash: resource.file.contentHash},
    };
}

function namedResources(
    value: JsonValue | undefined,
    expectedKind: ResourceInfo["kind"],
    context: MigrationContext,
    path: string,
): DecodeResult<readonly ResourceRefInfo[]> {
    if (value === undefined) return {ok: true, value: []};
    if (!Array.isArray(value)) return invalidJson(path, "expected an array");
    const result: ResourceRefInfo[] = [];
    for (let index = 0; index < value.length; index++) {
        const name = value[index];
        const itemPath = path + "[" + index + "]";
        if (typeof name !== "string") return invalidJson(itemPath, "expected a resource name");
        const resolved = resourceRef(name, expectedKind, context, itemPath);
        if (!resolved.ok) return resolved;
        result.push(resolved.value);
    }
    return {ok: true, value: result};
}

function resolveDef(value: JsonValue, context: MigrationContext): DecodeResult<MigrationInfo> {
    if (!isObject(value)) return invalidJson("$", "expected a migration object");
    const shape = exactOptionalKeys(value, ["id", "from", "to", "steps"], ["description", "before", "after"], "$");
    if (!shape.ok) return shape;

    const id = nonEmptyString(value.id, '$["id"]', "migration id");
    if (!id.ok) return id;
    if (typeof value.from !== "string") return invalidJson('$["from"]', "expected a release name");
    if (typeof value.to !== "string") return invalidJson('$["to"]', "expected a release name");

    const from = context.releases[value.from];
    if (from === undefined) return invalidReference('$["from"]', "unknown release " + JSON.stringify(value.from));
    const to = context.releases[value.to];
    if (to === undefined) return invalidReference('$["to"]', "unknown release " + JSON.stringify(value.to));
    if (value.from === value.to || from.releaseId === to.releaseId) {
        return invalidCatalog("$", "migration endpoints must differ");
    }
    if (from.systemId !== to.systemId) {
        return invalidCatalog("$", "migration endpoints must belong to the same system");
    }

    let description = "";
    if (value.description !== undefined) {
        if (typeof value.description !== "string") return invalidJson('$["description"]', "expected a string");
        description = value.description;
    }

    const before = namedResources(value.before, "check", context, '$["before"]');
    if (!before.ok) return before;
    const after = namedResources(value.after, "check", context, '$["after"]');
    if (!after.ok) return after;

    if (!Array.isArray(value.steps)) return invalidJson('$["steps"]', "expected an array");
    const steps: {id: string, run: ResourceRefInfo}[] = [];
    const stepIds = new Set<string>();
    for (let index = 0; index < value.steps.length; index++) {
        const rawStep = value.steps[index];
        const stepPath = '$["steps"][' + index + "]";
        if (!isObject(rawStep)) return invalidJson(stepPath, "expected a step object");
        const stepShape = exactKeys(rawStep, ["id", "run"], stepPath);
        if (!stepShape.ok) return stepShape;
        const stepId = nonEmptyString(rawStep.id, childPath(stepPath, "id"), "step id");
        if (!stepId.ok) return stepId;
        if (stepIds.has(stepId.value)) {
            return invalidCatalog(childPath(stepPath, "id"), "step ids must not repeat");
        }
        stepIds.add(stepId.value);
        if (typeof rawStep.run !== "string") return invalidJson(childPath(stepPath, "run"), "expected a resource name");
        const run = resourceRef(rawStep.run, "sql", context, childPath(stepPath, "run"));
        if (!run.ok) return run;
        steps.push({id: stepId.value, run: run.value});
    }

    return {
        ok: true,
        value: {
            id: id.value,
            from: copyRelease(from),
            to: copyRelease(to),
            description,
            before: before.value,
            steps,
            after: after.value,
        },
    };
}

export function completeMigration<
    const TContext extends MigrationContext,
    const TDef extends MigrationDef<TContext>,
>(
    context: TContext,
    def: TDef & ExactMigrationDef<TContext, TDef>,
): ValidationResult<MigrationInfoOf<TContext, TDef>> {
    const copied = toJsonValue(def);
    if (!copied.ok) return copied;
    const completed = resolveDef(copied.value, context);
    if (!completed.ok) return completed;
    return {ok: true, value: completed.value as MigrationInfoOf<TContext, TDef>};
}

function decodeReleaseRef(value: JsonValue, context: MigrationContext, path: string): DecodeResult<ReleaseRefInfo> {
    if (!isObject(value)) return invalidJson(path, "expected a release reference");
    const shape = exactKeys(value, ["systemId", "releaseId", "releaseHash"], path);
    if (!shape.ok) return shape;
    if (typeof value.systemId !== "string") return invalidJson(childPath(path, "systemId"), "expected a string");
    if (typeof value.releaseId !== "string") return invalidJson(childPath(path, "releaseId"), "expected a string");
    if (typeof value.releaseHash !== "string") return invalidJson(childPath(path, "releaseHash"), "expected a string");

    const match = Object.values(context.releases).find(reference => reference.releaseId === value.releaseId);
    if (match === undefined) {
        return invalidReference(childPath(path, "releaseId"), "unknown release " + JSON.stringify(value.releaseId));
    }
    if (match.systemId !== value.systemId) {
        return invalidReference(childPath(path, "systemId"), "release system does not match context");
    }
    if (match.releaseHash !== value.releaseHash) {
        return invalidReference(childPath(path, "releaseHash"), "release hash does not match context");
    }
    return {ok: true, value: copyRelease(match)};
}

function decodeResourceRef(
    value: JsonValue,
    expectedKind: ResourceInfo["kind"],
    context: MigrationContext,
    path: string,
): DecodeResult<ResourceRefInfo> {
    if (!isObject(value)) return invalidJson(path, "expected a resource reference");
    const shape = exactKeys(value, ["name", "kind", "contentHash"], path);
    if (!shape.ok) return shape;
    if (typeof value.name !== "string") return invalidJson(childPath(path, "name"), "expected a string");
    if (typeof value.kind !== "string") return invalidJson(childPath(path, "kind"), "expected a string");
    if (value.kind !== "sql" && value.kind !== "check") {
        return invalidJson(childPath(path, "kind"), "unsupported resource kind");
    }
    if (value.kind !== expectedKind) {
        return invalidResourceKind(childPath(path, "kind"), expectedKind, value.kind);
    }
    if (typeof value.contentHash !== "string") return invalidJson(childPath(path, "contentHash"), "expected a string");

    const resource = context.resources[value.name];
    if (resource === undefined) {
        return invalidReference(childPath(path, "name"), "unknown resource " + JSON.stringify(value.name));
    }
    if (resource.kind !== expectedKind) {
        return invalidResourceKind(childPath(path, "kind"), expectedKind, resource.kind);
    }
    if (resource.file.contentHash !== value.contentHash) {
        return invalidReference(childPath(path, "contentHash"), "resource hash does not match context");
    }
    return {ok: true, value: {name: value.name, kind: expectedKind, contentHash: value.contentHash}};
}

function decodeResourceRefs(
    value: JsonValue,
    expectedKind: ResourceInfo["kind"],
    context: MigrationContext,
    path: string,
): DecodeResult<readonly ResourceRefInfo[]> {
    if (!Array.isArray(value)) return invalidJson(path, "expected an array");
    const result: ResourceRefInfo[] = [];
    for (let index = 0; index < value.length; index++) {
        const decoded = decodeResourceRef(value[index], expectedKind, context, path + "[" + index + "]");
        if (!decoded.ok) return decoded;
        result.push(decoded.value);
    }
    return {ok: true, value: result};
}

function decodeCopiedMigration(value: JsonValue, context: MigrationContext): DecodeResult<MigrationInfo> {
    if (!isObject(value)) return invalidJson("$", "expected a migration object");
    const shape = exactKeys(value, ["id", "from", "to", "description", "before", "steps", "after"], "$");
    if (!shape.ok) return shape;

    const id = nonEmptyString(value.id, '$["id"]', "migration id");
    if (!id.ok) return id;
    const from = decodeReleaseRef(value.from, context, '$["from"]');
    if (!from.ok) return from;
    const to = decodeReleaseRef(value.to, context, '$["to"]');
    if (!to.ok) return to;
    if (from.value.releaseId === to.value.releaseId) {
        return invalidCatalog("$", "migration endpoints must differ");
    }
    if (from.value.systemId !== to.value.systemId) {
        return invalidCatalog("$", "migration endpoints must belong to the same system");
    }
    if (typeof value.description !== "string") return invalidJson('$["description"]', "expected a string");

    const before = decodeResourceRefs(value.before, "check", context, '$["before"]');
    if (!before.ok) return before;
    const after = decodeResourceRefs(value.after, "check", context, '$["after"]');
    if (!after.ok) return after;

    if (!Array.isArray(value.steps)) return invalidJson('$["steps"]', "expected an array");
    const steps: {id: string, run: ResourceRefInfo}[] = [];
    const stepIds = new Set<string>();
    for (let index = 0; index < value.steps.length; index++) {
        const rawStep = value.steps[index];
        const stepPath = '$["steps"][' + index + "]";
        if (!isObject(rawStep)) return invalidJson(stepPath, "expected a step object");
        const stepShape = exactKeys(rawStep, ["id", "run"], stepPath);
        if (!stepShape.ok) return stepShape;
        const stepId = nonEmptyString(rawStep.id, childPath(stepPath, "id"), "step id");
        if (!stepId.ok) return stepId;
        if (stepIds.has(stepId.value)) {
            return invalidCatalog(childPath(stepPath, "id"), "step ids must not repeat");
        }
        stepIds.add(stepId.value);
        const run = decodeResourceRef(rawStep.run, "sql", context, childPath(stepPath, "run"));
        if (!run.ok) return run;
        steps.push({id: stepId.value, run: run.value});
    }

    return {
        ok: true,
        value: {
            id: id.value,
            from: from.value,
            to: to.value,
            description: value.description,
            before: before.value,
            steps,
            after: after.value,
        },
    };
}

export function decodeMigration(
    value: unknown,
    context: MigrationContext,
): ValidationResult<MigrationInfo> {
    const copied = toJsonValue(value);
    if (!copied.ok) return copied;
    return decodeCopiedMigration(copied.value, context);
}

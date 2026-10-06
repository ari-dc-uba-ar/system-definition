import {ValidationResult, problem} from "./problem";
import {JsonValue, toJsonValue} from "./json-value";
import {childPath, exactKeys, exactOptionalKeys, isNonBlankString, isNonEmptyString, isPlainObject, isSha256, type StructuralFailure} from "./decode-structure";

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

export function sameReleaseRef(left: ReleaseRefInfo, right: ReleaseRefInfo): boolean {
    return left.systemId === right.systemId
        && left.releaseId === right.releaseId
        && left.releaseHash === right.releaseHash;
}

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

function isObject(value: JsonValue): value is JsonObject {
    return isPlainObject(value);
}

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

function nonEmptyString(
    value: unknown,
    path: string,
    label: string,
    invalid: StructuralFailure,
): DecodeResult<string> {
    if (typeof value !== "string") return invalid(path, "expected a string");
    if (!isNonBlankString(value)) return invalid(path, label + " must not be empty");
    return {ok: true, value};
}

function sha256String(
    value: unknown,
    path: string,
    label: string,
    invalid: StructuralFailure,
): DecodeResult<string> {
    if (!isSha256(value)) {
        return invalid(path, label + " must be a lowercase SHA-256 hex digest");
    }
    return {ok: true, value};
}

export function decodeFileInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<FileInfo> {
    if (!isPlainObject(value)) return invalid(path, "expected a file reference");
    const shape = exactKeys(value, ["path", "contentHash", "byteLength"], path, invalid);
    if (!shape.ok) return shape;
    if (!isNonEmptyString(value.path)) {
        return invalid(childPath(path, "path"), "file path must not be empty");
    }
    const contentHash = sha256String(value.contentHash, childPath(path, "contentHash"), "file contentHash", invalid);
    if (!contentHash.ok) return contentHash;
    if (typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
        return invalid(childPath(path, "byteLength"), "file byteLength must be a non-negative safe integer");
    }
    return {
        ok: true,
        value: {path: value.path, contentHash: contentHash.value, byteLength: value.byteLength},
    };
}

export function decodeReleaseRefInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<ReleaseRefInfo> {
    if (!isPlainObject(value)) return invalid(path, "expected a release reference");
    const shape = exactKeys(value, ["systemId", "releaseId", "releaseHash"], path, invalid);
    if (!shape.ok) return shape;
    const systemId = nonEmptyString(value.systemId, childPath(path, "systemId"), "systemId", invalid);
    if (!systemId.ok) return systemId;
    const releaseId = nonEmptyString(value.releaseId, childPath(path, "releaseId"), "releaseId", invalid);
    if (!releaseId.ok) return releaseId;
    const releaseHash = sha256String(value.releaseHash, childPath(path, "releaseHash"), "releaseHash", invalid);
    if (!releaseHash.ok) return releaseHash;
    return {ok: true, value: {systemId: systemId.value, releaseId: releaseId.value, releaseHash: releaseHash.value}};
}

export function decodeResourceRefInfo(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<ResourceRefInfo> {
    if (!isPlainObject(value)) return invalid(path, "expected a resource reference");
    const shape = exactKeys(value, ["name", "kind", "contentHash"], path, invalid);
    if (!shape.ok) return shape;
    const name = nonEmptyString(value.name, childPath(path, "name"), "resource name", invalid);
    if (!name.ok) return name;
    if (value.kind !== "sql" && value.kind !== "check") {
        return invalid(childPath(path, "kind"), "unsupported resource kind");
    }
    const contentHash = sha256String(value.contentHash, childPath(path, "contentHash"), "resource contentHash", invalid);
    if (!contentHash.ok) return contentHash;
    return {ok: true, value: {name: name.value, kind: value.kind, contentHash: contentHash.value}};
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
    const shape = exactOptionalKeys(value, ["id", "from", "to", "steps"], ["description", "before", "after"], "$", invalidJson);
    if (!shape.ok) return shape;

    const id = nonEmptyString(value.id, '$["id"]', "migration id", invalidJson);
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
        const stepShape = exactKeys(rawStep, ["id", "run"], stepPath, invalidJson);
        if (!stepShape.ok) return stepShape;
        const stepId = nonEmptyString(rawStep.id, childPath(stepPath, "id"), "step id", invalidJson);
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
    const decoded = decodeReleaseRefInfo(value, path, invalidJson);
    if (!decoded.ok) return decoded;
    const match = Object.values(context.releases).find(reference => reference.releaseId === decoded.value.releaseId);
    if (match === undefined) {
        return invalidReference(childPath(path, "releaseId"), "unknown release " + JSON.stringify(decoded.value.releaseId));
    }
    if (match.systemId !== decoded.value.systemId) {
        return invalidReference(childPath(path, "systemId"), "release system does not match context");
    }
    if (match.releaseHash !== decoded.value.releaseHash) {
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
    const decoded = decodeResourceRefInfo(value, path, invalidJson);
    if (!decoded.ok) return decoded;
    if (decoded.value.kind !== expectedKind) {
        return invalidResourceKind(childPath(path, "kind"), expectedKind, decoded.value.kind);
    }
    const resource = context.resources[decoded.value.name];
    if (resource === undefined) {
        return invalidReference(childPath(path, "name"), "unknown resource " + JSON.stringify(decoded.value.name));
    }
    if (resource.kind !== expectedKind) {
        return invalidResourceKind(childPath(path, "kind"), expectedKind, resource.kind);
    }
    if (resource.file.contentHash !== decoded.value.contentHash) {
        return invalidReference(childPath(path, "contentHash"), "resource hash does not match context");
    }
    return {ok: true, value: {name: decoded.value.name, kind: expectedKind, contentHash: decoded.value.contentHash}};
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
    const shape = exactKeys(value, ["id", "from", "to", "description", "before", "steps", "after"], "$", invalidJson);
    if (!shape.ok) return shape;

    const id = nonEmptyString(value.id, '$["id"]', "migration id", invalidJson);
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
        const stepShape = exactKeys(rawStep, ["id", "run"], stepPath, invalidJson);
        if (!stepShape.ok) return stepShape;
        const stepId = nonEmptyString(rawStep.id, childPath(stepPath, "id"), "step id", invalidJson);
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

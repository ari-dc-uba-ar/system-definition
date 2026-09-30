import {createHash} from "node:crypto";
import {
    type ResourceRefInfo,
    type ValidationResult,
    problem,
} from "system-definition";
import {
    type AuthoringContext,
    type PortInfo,
    type SourceSelectionInfo,
} from "./migration-authoring";

export type SourceTableRef = {
    entity: string;
    alias: string;
};

export type SourceFieldSelection = {
    alias: string;
    field: string;
};

export type SourceJoinPair = {
    left: SourceFieldSelection;
    right: SourceFieldSelection;
};

export type SourceJoinDef = {
    kind: "inner" | "left";
    entity: string;
    alias: string;
    on: readonly SourceJoinPair[];
    whenUnmatched: "include" | "exclude";
};

export type SourceSelectionDef = {
    queryName: string;
    schema: string;
    base: SourceTableRef;
    joins: readonly SourceJoinDef[];
    ports: Readonly<Record<string, SourceFieldSelection>>;
    identity: readonly string[];
    coverageChecks: readonly ResourceRefInfo[];
};

export type GeneratedSourceSelectionInfo = {
    selection: SourceSelectionInfo;
    sql: string;
};

type AliasInfo = {
    entity: string;
    nullable: boolean;
};

function failure<T>(reason: string, details: Readonly<Record<string, unknown>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.authoringInvalid", "blocking", {reason, ...details})],
    };
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, entity: string): string {
    return `${quoteIdentifier(schema)}.${quoteIdentifier(entity)}`;
}

function fieldSql(ref: SourceFieldSelection): string {
    return `${quoteIdentifier(ref.alias)}.${quoteIdentifier(ref.field)}`;
}

function hashSql(sql: string): string {
    return createHash("sha256").update(sql, "utf8").digest("hex");
}

function isNonEmpty(value: string): boolean {
    return value.length > 0;
}

function validCheck(ref: ResourceRefInfo): boolean {
    return ref.kind === "check"
        && isNonEmpty(ref.name)
        && /^[0-9a-f]{64}$/.test(ref.contentHash);
}

function fieldFor(
    context: AuthoringContext,
    aliases: ReadonlyMap<string, AliasInfo>,
    ref: SourceFieldSelection,
): ValidationResult<{entity: string; type: string; nullable: boolean}> {
    const alias = aliases.get(ref.alias);
    if (alias === undefined) return failure("unknown source alias", {alias: ref.alias});
    const entity = context.from.entities[alias.entity];
    if (entity === undefined) return failure("unknown source entity", {entity: alias.entity});
    const field = entity.fields[ref.field];
    if (field === undefined) {
        return failure("unknown source field", {entity: alias.entity, field: ref.field});
    }
    return {
        ok: true,
        value: {
            entity: alias.entity,
            type: field.type,
            nullable: field.nullable || alias.nullable,
        },
    };
}

function validateJoinPolicy(join: SourceJoinDef): ValidationResult<true> {
    if (join.kind === "left" && join.whenUnmatched !== "include") {
        return failure("LEFT JOIN cannot claim unmatched rows are excluded without an explicit query contract", {
            alias: join.alias,
        });
    }
    if (join.kind === "inner" && join.whenUnmatched !== "exclude") {
        return failure("INNER JOIN excludes unmatched rows and must declare that policy", {alias: join.alias});
    }
    return {ok: true, value: true};
}

function copyChecks(checks: readonly ResourceRefInfo[]): ValidationResult<readonly ResourceRefInfo[]> {
    const seen = new Set<string>();
    const result: ResourceRefInfo[] = [];
    for (const ref of checks) {
        if (!validCheck(ref)) return failure("invalid coverage check", {name: ref.name});
        const key = `${ref.name}\u0000${ref.contentHash}`;
        if (seen.has(key)) return failure("duplicate coverage check", {name: ref.name});
        seen.add(key);
        result.push({name: ref.name, kind: "check", contentHash: ref.contentHash});
    }
    return {ok: true, value: result};
}

/**
 * Build the deterministic wizard-supported SELECT contract from the historical
 * `from` snapshot. More complex filters/aggregations/custom SQL use an explicit
 * QueryRefInfo contract instead of being guessed here.
 */
export function buildSourceSelection(
    context: AuthoringContext,
    def: SourceSelectionDef,
): ValidationResult<GeneratedSourceSelectionInfo> {
    if (!isNonEmpty(def.queryName)) return failure("queryName must be non-empty");
    if (!isNonEmpty(def.schema)) return failure("schema must be non-empty");
    if (!isNonEmpty(def.base.entity) || !isNonEmpty(def.base.alias)) {
        return failure("base entity and alias must be non-empty");
    }
    if (context.from.entities[def.base.entity] === undefined) {
        return failure("unknown base entity", {entity: def.base.entity});
    }

    const aliases = new Map<string, AliasInfo>();
    aliases.set(def.base.alias, {entity: def.base.entity, nullable: false});

    const joinSql: string[] = [];
    let excludesRows = false;

    for (const join of def.joins) {
        if (!isNonEmpty(join.entity) || !isNonEmpty(join.alias)) {
            return failure("join entity and alias must be non-empty");
        }
        if (aliases.has(join.alias)) return failure("duplicate source alias", {alias: join.alias});
        if (context.from.entities[join.entity] === undefined) {
            return failure("unknown join entity", {entity: join.entity});
        }
        const policy = validateJoinPolicy(join);
        if (!policy.ok) return policy;
        if (join.on.length === 0) {
            return failure("joins require explicit equality pairs", {alias: join.alias});
        }

        const joinAliases = new Map(aliases);
        joinAliases.set(join.alias, {entity: join.entity, nullable: join.kind === "left"});
        const predicates: string[] = [];
        for (const pair of join.on) {
            const left = fieldFor(context, joinAliases, pair.left);
            if (!left.ok) return left;
            const right = fieldFor(context, joinAliases, pair.right);
            if (!right.ok) return right;
            if (pair.left.alias !== join.alias && pair.right.alias !== join.alias) {
                return failure("join equality must reference the joined alias", {alias: join.alias});
            }
            if (pair.left.alias === join.alias && pair.right.alias === join.alias) {
                return failure("join equality must connect the joined alias to an existing alias", {alias: join.alias});
            }
            if (left.value.type !== right.value.type) {
                return failure("join equality fields have incompatible types", {
                    leftType: left.value.type,
                    rightType: right.value.type,
                });
            }
            predicates.push(`${fieldSql(pair.left)} = ${fieldSql(pair.right)}`);
        }
        predicates.sort();
        const keyword = join.kind === "left" ? "LEFT JOIN" : "INNER JOIN";
        joinSql.push(
            `${keyword} ${qualified(def.schema, join.entity)} AS ${quoteIdentifier(join.alias)} ON ${predicates.join(" AND ")}`,
        );
        aliases.set(join.alias, {entity: join.entity, nullable: join.kind === "left"});
        if (join.whenUnmatched === "exclude") excludesRows = true;
    }

    const coverage = copyChecks(def.coverageChecks);
    if (!coverage.ok) return coverage;
    if (excludesRows && coverage.value.length === 0) {
        return failure("excluded source rows require explicit coverage checks");
    }

    const portNames = Object.keys(def.ports).sort();
    if (portNames.length === 0) return failure("source selection must expose at least one port");

    const ports: Record<string, PortInfo> = {};
    const selectSql: string[] = [];
    for (const name of portNames) {
        if (!isNonEmpty(name) || name.startsWith("__")) {
            return failure("invalid source port name", {port: name});
        }
        const ref = def.ports[name]!;
        const source = fieldFor(context, aliases, ref);
        if (!source.ok) return source;
        ports[name] = {
            domain: {side: "from", type: source.value.type, nullable: source.value.nullable},
            field: {side: "from", entity: source.value.entity, field: ref.field},
        };
        selectSql.push(`  ${fieldSql(ref)} AS ${quoteIdentifier(name)}`);
    }

    if (def.identity.length === 0) return failure("source identity must not be empty");
    const identity: string[] = [];
    const identitySeen = new Set<string>();
    for (const name of def.identity) {
        if (identitySeen.has(name)) return failure("duplicate source identity port", {port: name});
        identitySeen.add(name);
        const port = ports[name];
        if (port === undefined) return failure("unknown source identity port", {port: name});
        if (port.domain.nullable) return failure("source identity port must be non-null", {port: name});
        identity.push(name);
    }

    const sql = [
        "SELECT",
        selectSql.join(",\n"),
        `FROM ${qualified(def.schema, def.base.entity)} AS ${quoteIdentifier(def.base.alias)}`,
        ...joinSql,
        ";",
        "",
    ].join("\n");

    return {
        ok: true,
        value: {
            selection: {
                query: {name: def.queryName, kind: "query", contentHash: hashSql(sql)},
                ports,
                identity,
                coverageChecks: coverage.value,
            },
            sql,
        },
    };
}

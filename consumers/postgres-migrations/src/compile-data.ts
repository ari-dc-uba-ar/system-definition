import {createHash} from "node:crypto";
import {problem, type ValidationResult} from "system-definition";
import type {
    DataMigrationInfo,
    QueryRefInfo,
    TransformationInfo,
    WriteInfo,
} from "./migration-authoring";

export type RelationRewriteRequest = {
    sql: string;
    relations: {
        migration_input: string;
        migration_parameters: string;
    };
};

export type RelationRewriter = {
    rewrite(request: RelationRewriteRequest): ValidationResult<string>;
};

export type ResolvedQuery = {
    ref: QueryRefInfo;
    text: string;
};

export type CompileDataContext = {
    migrationId: string;
    schema: string;
    transformation: TransformationInfo;
    sourceQuery: ResolvedQuery;
    transformationQuery: ResolvedQuery;
    lineageQuery: ResolvedQuery | null;
    relationRewriter: RelationRewriter;
};

export type CompiledDataStatement = {
    phase: "capture" | "parameters" | "transform" | "lineage" | "protocol" | "prewrite" | "write";
    text: string;
    values: readonly unknown[];
};

export type CompiledDataMigration = {
    temporary: {
        input: string;
        parameters: string;
        output: string;
        lineage: string | null;
    };
    statements: readonly CompiledDataStatement[];
};

function failure<T>(reason: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.dataCompilationInvalid", "blocking", {reason, ...details})],
    };
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, entity: string): string {
    return `${quoteIdentifier(schema)}.${quoteIdentifier(entity)}`;
}

function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function queryMatches(resolved: ResolvedQuery): boolean {
    return resolved.ref.kind === "query"
        && /^[0-9a-f]{64}$/.test(resolved.ref.contentHash)
        && hashText(resolved.text) === resolved.ref.contentHash;
}

function stripFinalSemicolon(text: string): string {
    const trimmed = text.trimEnd();
    return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

function tempStem(migration: DataMigrationInfo, context: CompileDataContext): string {
    const hash = createHash("sha256")
        .update(context.migrationId, "utf8")
        .update("\0", "utf8")
        .update(migration.id, "utf8")
        .update("\0", "utf8")
        .update(context.transformation.name, "utf8")
        .update("\0", "utf8")
        .update(context.transformation.version, "utf8")
        .digest("hex")
        .slice(0, 16);
    return `__migration_${hash}`;
}

function sameQueryRef(left: QueryRefInfo, right: QueryRefInfo): boolean {
    return left.kind === right.kind && left.name === right.name && left.contentHash === right.contentHash;
}

function validateBoundary(
    migration: DataMigrationInfo,
    context: CompileDataContext,
): ValidationResult<true> {
    if (migration.transformation !== context.transformation.name) {
        return failure("migration references a different transformation", {
            expected: migration.transformation,
            actual: context.transformation.name,
        });
    }
    if (context.transformation.mode === "row") {
        if (context.transformation.lineage !== null || context.lineageQuery !== null) {
            return failure("row transformations must not declare lineage");
        }
    } else {
        if (context.transformation.lineage === null || context.lineageQuery === null) {
            return failure("set transformations require lineage");
        }
        if (!sameQueryRef(context.transformation.lineage, context.lineageQuery.ref)) {
            return failure("resolved lineage query reference does not match the transformation contract");
        }
    }
    if (Object.keys(context.transformation.parameters).length !== 0 || Object.keys(migration.arguments).length !== 0) {
        return failure("typed transformation parameters are not part of this compiler slice");
    }
    if (!sameQueryRef(migration.source.query, context.sourceQuery.ref)) {
        return failure("resolved source query reference does not match the migration contract");
    }
    if (!sameQueryRef(context.transformation.query, context.transformationQuery.ref)) {
        return failure("resolved transformation query reference does not match the transformation contract");
    }
    if (!queryMatches(context.sourceQuery)) {
        return failure("source query bytes do not match their content hash", {query: context.sourceQuery.ref.name});
    }
    if (!queryMatches(context.transformationQuery)) {
        return failure("transformation query bytes do not match their content hash", {query: context.transformationQuery.ref.name});
    }
    if (context.lineageQuery !== null && !queryMatches(context.lineageQuery)) {
        return failure("lineage query bytes do not match their content hash", {query: context.lineageQuery.ref.name});
    }
    if (migration.source.identity.length === 0) {
        return failure("source identity must contain at least one port");
    }
    for (const name of migration.source.identity) {
        const port = migration.source.ports[name];
        if (port === undefined) return failure("source identity names an unknown port", {port: name});
        if (port.domain.nullable) return failure("source identity port must be non-null", {port: name});
    }
    for (const write of migration.writes) {
        if (write.kind !== "update" || write.whenMissing !== "error") {
            return failure("this compiler slice accepts update writes with whenMissing=error only", {entity: write.entity});
        }
        if (write.match.length === 0) return failure("update write must have a match", {entity: write.entity});
        if (write.values.length === 0) return failure("update write must have values", {entity: write.entity});
    }
    return {ok: true, value: true};
}

function captureSql(
    migration: DataMigrationInfo,
    sourceText: string,
    input: string,
): string {
    const identity = migration.source.identity.map(quoteIdentifier).join(", ");
    return [
        `CREATE TEMP TABLE ${quoteIdentifier(input)} ON COMMIT DROP AS`,
        `SELECT row_number() OVER (ORDER BY ${identity}) AS "__source_id", "source".*`,
        "FROM (",
        stripFinalSemicolon(sourceText),
        `) AS "source";`,
    ].join("\n");
}

function parametersSql(parameters: string): string {
    // Row-mode without declared parameters still gets a one-row logical relation so the
    // parser/AST rewriter always has the same two relation names available.
    return [
        `CREATE TEMP TABLE ${quoteIdentifier(parameters)} ON COMMIT DROP AS`,
        `SELECT 1::integer AS "__present";`,
    ].join("\n");
}

function transformSql(output: string, rewritten: string): string {
    return [
        `CREATE TEMP TABLE ${quoteIdentifier(output)} ON COMMIT DROP AS`,
        `${stripFinalSemicolon(rewritten)};`,
    ].join("\n");
}

function rowProtocolSql(input: string, output: string): string {
    const inputName = quoteIdentifier(input);
    const outputName = quoteIdentifier(output);
    return [
        "SELECT 1 / CASE WHEN (",
        "    EXISTS (",
        `        SELECT "__source_id" FROM ${outputName}`,
        `        GROUP BY "__source_id" HAVING count(*) <> 1`,
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${outputName} AS "output"`,
        `        LEFT JOIN ${inputName} AS "input"`,
        `          ON "input"."__source_id" IS NOT DISTINCT FROM "output"."__source_id"`,
        `        WHERE "input"."__source_id" IS NULL`,
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${inputName} AS "input"`,
        `        LEFT JOIN ${outputName} AS "output"`,
        `          ON "output"."__source_id" IS NOT DISTINCT FROM "input"."__source_id"`,
        `        WHERE "output"."__source_id" IS NULL`,
        "    )",
        ` ) THEN 0 ELSE 1 END AS "row_protocol_ok";`,
    ].join("\n");
}

function lineageSql(lineage: string, rewritten: string): string {
    return [
        `CREATE TEMP TABLE ${quoteIdentifier(lineage)} ON COMMIT DROP AS`,
        `${stripFinalSemicolon(rewritten)};`,
    ].join("\n");
}

function setProtocolSql(input: string, output: string, lineage: string): string {
    const inputName = quoteIdentifier(input);
    const outputName = quoteIdentifier(output);
    const lineageName = quoteIdentifier(lineage);
    return [
        "SELECT 1 / CASE WHEN (",
        "    EXISTS (",
        `        SELECT 1 FROM ${outputName}`,
        `        WHERE "__output_id" IS NULL`,
        "    )",
        "    OR EXISTS (",
        `        SELECT "__output_id" FROM ${outputName}`,
        `        GROUP BY "__output_id" HAVING count(*) <> 1`,
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${lineageName}`,
        `        WHERE "__source_id" IS NULL OR "__output_id" IS NULL`,
        "    )",
        "    OR EXISTS (",
        `        SELECT "__source_id", "__output_id" FROM ${lineageName}`,
        `        GROUP BY "__source_id", "__output_id" HAVING count(*) <> 1`,
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${lineageName} AS "lineage"`,
        `        LEFT JOIN ${inputName} AS "input"`,
        `          ON "input"."__source_id" IS NOT DISTINCT FROM "lineage"."__source_id"`,
        `        LEFT JOIN ${outputName} AS "output"`,
        `          ON "output"."__output_id" IS NOT DISTINCT FROM "lineage"."__output_id"`,
        `        WHERE "input"."__source_id" IS NULL OR "output"."__output_id" IS NULL`,
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${inputName} AS "input"`,
        `        LEFT JOIN ${lineageName} AS "lineage"`,
        `          ON "lineage"."__source_id" IS NOT DISTINCT FROM "input"."__source_id"`,
        `        WHERE "lineage"."__source_id" IS NULL`,
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${outputName} AS "output"`,
        `        LEFT JOIN ${lineageName} AS "lineage"`,
        `          ON "lineage"."__output_id" IS NOT DISTINCT FROM "output"."__output_id"`,
        `        WHERE "lineage"."__output_id" IS NULL`,
        "    )",
        ` ) THEN 0 ELSE 1 END AS "set_protocol_ok";`,
    ].join("\n");
}

function matchPredicate(write: Extract<WriteInfo, {kind: "update"}>): string {
    return write.match.map(pair => (
        `"target".${quoteIdentifier(pair.targetField)} IS NOT DISTINCT FROM "output".${quoteIdentifier(pair.output)}`
    )).join("\n    AND ");
}

function prewriteSql(
    write: Extract<WriteInfo, {kind: "update"}>,
    schema: string,
    output: string,
    identityColumn: "__source_id" | "__output_id",
): string {
    return [
        "SELECT 1 / CASE WHEN EXISTS (",
        `    SELECT "output".${quoteIdentifier(identityColumn)}`,
        `    FROM ${quoteIdentifier(output)} AS "output"`,
        `    LEFT JOIN ${qualified(schema, write.entity)} AS "target"`,
        `      ON ${matchPredicate(write)}`,
        `    GROUP BY "output".${quoteIdentifier(identityColumn)}`,
        `    HAVING count("target".ctid) <> 1`,
        ` ) THEN 0 ELSE 1 END AS "update_match_ok";`,
    ].join("\n");
}

function updateSql(
    write: Extract<WriteInfo, {kind: "update"}>,
    schema: string,
    output: string,
): string {
    const assignments = write.values.map(binding => (
        `${quoteIdentifier(binding.target.field)} = "output".${quoteIdentifier(binding.output)}`
    )).join(",\n    ");
    return [
        `UPDATE ${qualified(schema, write.entity)} AS "target"`,
        "SET " + assignments,
        `FROM ${quoteIdentifier(output)} AS "output"`,
        `WHERE ${matchPredicate(write)};`,
    ].join("\n");
}

export function compileDataMigration(
    migration: DataMigrationInfo,
    context: CompileDataContext,
): ValidationResult<CompiledDataMigration> {
    const boundary = validateBoundary(migration, context);
    if (!boundary.ok) return boundary;

    // Exact query bytes are validated above. Only after that may SQL parsing/rewrite run.
    const stem = tempStem(migration, context);
    const temporary = {
        input: `${stem}_input`,
        parameters: `${stem}_parameters`,
        output: `${stem}_output`,
        lineage: context.transformation.mode === "set" ? `${stem}_lineage` : null,
    } as const;
    const relations = {
        migration_input: temporary.input,
        migration_parameters: temporary.parameters,
    };

    const rewritten = context.relationRewriter.rewrite({
        sql: context.transformationQuery.text,
        relations,
    });
    if (!rewritten.ok) return {ok: false, problems: rewritten.problems};

    let rewrittenLineage: string | null = null;
    if (context.transformation.mode === "set") {
        // validateBoundary proves both values are present and exact-byte verified before
        // either parser invocation can run.
        const lineageQuery = context.lineageQuery as ResolvedQuery;
        const result = context.relationRewriter.rewrite({sql: lineageQuery.text, relations});
        if (!result.ok) return {ok: false, problems: result.problems};
        rewrittenLineage = result.value;
    }

    const statements: CompiledDataStatement[] = [
        {phase: "capture", text: captureSql(migration, context.sourceQuery.text, temporary.input), values: []},
        {phase: "parameters", text: parametersSql(temporary.parameters), values: []},
        {phase: "transform", text: transformSql(temporary.output, rewritten.value), values: []},
    ];
    if (temporary.lineage !== null && rewrittenLineage !== null) {
        statements.push({phase: "lineage", text: lineageSql(temporary.lineage, rewrittenLineage), values: []});
        statements.push({
            phase: "protocol",
            text: setProtocolSql(temporary.input, temporary.output, temporary.lineage),
            values: [],
        });
    } else {
        statements.push({phase: "protocol", text: rowProtocolSql(temporary.input, temporary.output), values: []});
    }

    for (const rawWrite of migration.writes) {
        // validateBoundary rejects every other variant for this approved slice.
        const write = rawWrite as Extract<WriteInfo, {kind: "update"}>;
        statements.push({
            phase: "prewrite",
            text: prewriteSql(
                write,
                context.schema,
                temporary.output,
                context.transformation.mode === "set" ? "__output_id" : "__source_id",
            ),
            values: [],
        });
        statements.push({
            phase: "write",
            text: updateSql(write, context.schema, temporary.output),
            values: [],
        });
    }

    return {ok: true, value: {temporary, statements}};
}

import {createHash} from "node:crypto";
import {compareUtf16, isSha256, problem, sameContentRef, type PersistenceInfo, type SystemSnapshotInfo, type ValidationResult} from "system-definition";
import type {
    DataMigrationInfo,
    QueryRefInfo,
    TransformationInfo,
    WriteInfo,
} from "./migration-authoring";
import type {MachineCodecInfo, PgSchemaInfo, PgTypeRepresentation, StorageContext} from "./pg-schema";
import {isPgIdentifierText, quotePgIdentifier, quotePgQualified} from "./pg-sql";

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
    storage?: StorageContext;
    persistence?: PersistenceInfo;
    targetSnapshot?: SystemSnapshotInfo;
    targetSchema?: PgSchemaInfo;
};

export type CompiledDataStatement = {
    phase: "capture" | "parameters" | "transform" | "lineage" | "protocol" | "preserve" | "prewrite" | "write" | "verify";
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
    conservationChecks: DataMigrationInfo["conservationChecks"];
};

function failure<T>(reason: string, details: Readonly<Record<string, string>> = {}): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.dataCompilationInvalid", "blocking", {reason, ...details})],
    };
}

function hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function queryMatches(resolved: ResolvedQuery): boolean {
    return resolved.ref.kind === "query"
        && isSha256(resolved.ref.contentHash)
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

function validateIdentifierText(value: string, role: string): ValidationResult<true> {
    if (!isPgIdentifierText(value)) {
        return failure("PostgreSQL identifier contains NUL", {role});
    }
    return {ok: true, value: true};
}

function validateSqlIdentifiers(
    migration: DataMigrationInfo,
    context: CompileDataContext,
): ValidationResult<true> {
    const values: {value: string; role: string}[] = [
        {value: context.schema, role: "schema"},
        ...migration.source.identity.map(value => ({value, role: "source identity"})),
        ...Object.keys(context.transformation.parameters).map(value => ({value, role: "transformation parameter"})),
    ];
    const writtenEntities = new Set<string>();
    for (const write of migration.writes) {
        writtenEntities.add(write.entity);
        values.push({value: write.entity, role: "destination entity"});
        for (const binding of write.values) {
            values.push({value: binding.target.field, role: "destination field"});
            values.push({value: binding.output, role: "transformation output"});
        }
        if (write.kind === "update") {
            for (const pair of write.match) {
                values.push({value: pair.targetField, role: "update match field"});
                values.push({value: pair.output, role: "update match output"});
            }
        }
    }
    if (context.targetSnapshot !== undefined) {
        for (const entityName of writtenEntities) {
            const entity = context.targetSnapshot.entities[entityName];
            if (entity === undefined) continue;
            for (const field of Object.keys(entity.fields)) {
                values.push({value: field, role: "destination snapshot field"});
            }
        }
    }
    for (const one of values) {
        const valid = validateIdentifierText(one.value, one.role);
        if (!valid.ok) return valid;
    }
    return {ok: true, value: true};
}

function validateBoundary(
    migration: DataMigrationInfo,
    context: CompileDataContext,
): ValidationResult<true> {
    const identifiers = validateSqlIdentifiers(migration, context);
    if (!identifiers.ok) return identifiers;
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
        if (!sameContentRef(context.transformation.lineage, context.lineageQuery.ref)) {
            return failure("resolved lineage query reference does not match the transformation contract");
        }
    }
    if (!sameContentRef(migration.source.query, context.sourceQuery.ref)) {
        return failure("resolved source query reference does not match the migration contract");
    }
    if (!sameContentRef(context.transformation.query, context.transformationQuery.ref)) {
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
    const writes = validateWrites(migration, context);
    if (!writes.ok) return writes;
    return {ok: true, value: true};
}


type TargetColumn = Extract<PgSchemaInfo["objects"][number], {kind: "column"}>;

type DestinationContract = {
    entity: SystemSnapshotInfo["entities"][string];
    columns: Readonly<Record<string, TargetColumn>>;
};

function destinationContract(
    context: CompileDataContext,
    entityName: string,
): ValidationResult<DestinationContract> {
    const entity = context.targetSnapshot?.entities[entityName];
    if (entity === undefined || context.targetSchema === undefined) {
        return failure("destination writes require target snapshot and schema metadata", {entity: entityName});
    }
    const columns: Record<string, TargetColumn> = {};
    for (const object of context.targetSchema.objects) {
        if (object.kind !== "column"
            || object.identity.schema !== context.schema
            || object.identity.parentName !== entityName) continue;
        columns[object.identity.name] = object;
    }
    for (const fieldName of Object.keys(entity.fields)) {
        if (columns[fieldName] === undefined) {
            return failure("destination schema is missing a snapshot field", {entity: entityName, field: fieldName});
        }
    }
    return {ok: true, value: {entity, columns}};
}

function sameFieldSet(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every(name => rightSet.has(name));
}

function isCompleteDestinationKey(
    entity: DestinationContract["entity"],
    fields: readonly string[],
): boolean {
    if (sameFieldSet(fields, entity.pk)) return true;
    return Object.values(entity.uks).some(key => sameFieldSet(fields, key));
}

function isGeneratedColumn(column: TargetColumn): boolean {
    return column.generatedDefinition !== null || column.identityDefinition !== null;
}

function validateWriteBindings(
    write: WriteInfo,
    contract: DestinationContract,
): ValidationResult<true> {
    if (write.values.length === 0) return failure("destination write must have values", {entity: write.entity});
    const seen = new Set<string>();
    for (const binding of write.values) {
        const field = binding.target.field;
        if (binding.target.side !== "to" || binding.target.entity !== write.entity || contract.entity.fields[field] === undefined) {
            return failure("destination write references an unknown target field", {entity: write.entity, field});
        }
        if (seen.has(field)) {
            return failure("destination write repeats a target field", {entity: write.entity, field});
        }
        seen.add(field);
        if (isGeneratedColumn(contract.columns[field]!)) {
            return failure("generated destination fields cannot be written explicitly", {entity: write.entity, field});
        }
    }
    return {ok: true, value: true};
}

function requiredInsertFields(contract: DestinationContract): readonly string[] {
    return Object.keys(contract.entity.fields).filter(field => {
        const snapshotField = contract.entity.fields[field]!;
        const column = contract.columns[field]!;
        return !snapshotField.nullable
            && column.defaultExpression === null
            && !isGeneratedColumn(column);
    });
}

function validateInsertCompleteness(
    entityName: string,
    contract: DestinationContract,
    supplied: ReadonlySet<string>,
): ValidationResult<true> {
    const missing = requiredInsertFields(contract).find(field => !supplied.has(field));
    if (missing !== undefined) {
        return failure("insert is missing a required destination field", {entity: entityName, field: missing});
    }
    return {ok: true, value: true};
}

function validateInsertWrite(
    write: Extract<WriteInfo, {kind: "insert"}>,
    context: CompileDataContext,
): ValidationResult<true> {
    const contractResult = destinationContract(context, write.entity);
    if (!contractResult.ok) return contractResult;
    const contract = contractResult.value;
    const bindings = validateWriteBindings(write, contract);
    if (!bindings.ok) return bindings;
    if (write.key.length === 0 || !isCompleteDestinationKey(contract.entity, write.key)) {
        return failure("insert key must cover one complete destination PK or UK", {entity: write.entity});
    }
    const supplied = new Set(write.values.map(binding => binding.target.field));
    const missingKey = write.key.find(field => !supplied.has(field));
    if (missingKey !== undefined) {
        return failure("insert key field must be supplied by an output", {entity: write.entity, field: missingKey});
    }
    return validateInsertCompleteness(write.entity, contract, supplied);
}

function validateUpdateWrite(
    write: Extract<WriteInfo, {kind: "update"}>,
    context: CompileDataContext,
): ValidationResult<true> {
    if (write.match.length === 0) return failure("update write must have a match", {entity: write.entity});

    if (context.targetSnapshot === undefined) {
        if (write.whenMissing !== "error") {
            return failure("destination writes require target snapshot and schema metadata", {entity: write.entity});
        }
        if (write.values.length === 0) return failure("update write must have values", {entity: write.entity});
        return {ok: true, value: true};
    }

    const contractResult = destinationContract(context, write.entity);
    if (!contractResult.ok) return contractResult;
    const contract = contractResult.value;
    const bindings = validateWriteBindings(write, contract);
    if (!bindings.ok) return bindings;

    const matchFields: string[] = [];
    const seenMatch = new Set<string>();
    for (const pair of write.match) {
        if (contract.entity.fields[pair.targetField] === undefined) {
            return failure("update match references an unknown destination field", {entity: write.entity, field: pair.targetField});
        }
        if (seenMatch.has(pair.targetField)) {
            return failure("update match repeats a destination field", {entity: write.entity, field: pair.targetField});
        }
        seenMatch.add(pair.targetField);
        matchFields.push(pair.targetField);
    }
    if (!isCompleteDestinationKey(contract.entity, matchFields)) {
        return failure("update match must cover one complete destination PK or UK", {entity: write.entity});
    }

    const changedMatched = write.values.find(binding => seenMatch.has(binding.target.field));
    if (changedMatched !== undefined) {
        return failure("update cannot modify a field used by its own match", {
            entity: write.entity,
            field: changedMatched.target.field,
        });
    }

    if (write.whenMissing === "insert") {
        const supplied = new Set<string>(matchFields);
        for (const binding of write.values) supplied.add(binding.target.field);
        const completeness = validateInsertCompleteness(write.entity, contract, supplied);
        if (!completeness.ok) return completeness;
    }
    return {ok: true, value: true};
}

function validateWrites(
    migration: DataMigrationInfo,
    context: CompileDataContext,
): ValidationResult<true> {
    for (const write of migration.writes) {
        const result = write.kind === "insert"
            ? validateInsertWrite(write, context)
            : validateUpdateWrite(write, context);
        if (!result.ok) return result;
    }
    return {ok: true, value: true};
}

function captureSql(
    migration: DataMigrationInfo,
    sourceText: string,
    input: string,
): string {
    const identity = migration.source.identity.map(quotePgIdentifier).join(", ");
    return [
        `CREATE TEMP TABLE ${quotePgIdentifier(input)} ON COMMIT DROP AS`,
        `SELECT row_number() OVER (ORDER BY ${identity}) AS "__source_id", "source".*`,
        "FROM (",
        stripFinalSemicolon(sourceText),
        `) AS "source";`,
    ].join("\n");
}

type CompiledParameters = {
    text: string;
    values: readonly (string | null)[];
};

function sameDomain(
    left: {side: string; type: string; nullable: boolean},
    right: {side: string; type: string; nullable: boolean},
): boolean {
    return left.side === right.side && left.type === right.type && left.nullable === right.nullable;
}

function pgTypeSql(type: PgTypeRepresentation): ValidationResult<string> {
    if (type.schema.length === 0 || type.name.length === 0 || type.schema.includes("\0") || type.name.includes("\0")) {
        return failure("physical type has an invalid PostgreSQL identity");
    }
    if (type.modifiers.some(modifier => !/^[0-9]+$/.test(modifier))) {
        return failure("physical type has an unsupported PostgreSQL modifier");
    }
    const modifiers = type.modifiers.length === 0 ? "" : `(${type.modifiers.join(", ")})`;
    return {ok: true, value: `${quotePgIdentifier(type.schema)}.${quotePgIdentifier(type.name)}${modifiers}`};
}

function requireCodec(
    storage: StorageContext,
    physicalName: string,
): ValidationResult<{codec: MachineCodecInfo; physical: PgTypeRepresentation; transport: PgTypeRepresentation}> {
    const physical = storage.physicalTypes[physicalName];
    if (physical === undefined) {
        return failure("physical type mapping is missing", {physicalType: physicalName});
    }
    const codec = storage.machineCodecs?.[physicalName];
    if (codec === undefined || codec.readExpression.length === 0 || codec.transportType.length === 0) {
        return failure("machine codec contract is missing", {physicalType: physicalName});
    }
    const transport = storage.physicalTypes[codec.transportType];
    if (transport === undefined) {
        return failure("codec transport type is missing", {
            physicalType: physicalName,
            transportType: codec.transportType,
        });
    }
    return {ok: true, value: {codec, physical, transport}};
}

function compileParameters(
    migration: DataMigrationInfo,
    context: CompileDataContext,
    parameters: string,
): ValidationResult<CompiledParameters> {
    const parameterNames = Object.keys(context.transformation.parameters).sort(compareUtf16);
    const argumentNames = Object.keys(migration.arguments).sort(compareUtf16);

    if (parameterNames.length === 0 && argumentNames.length === 0) {
        // Parameter-free transformations still receive a one-row logical relation so every
        // query is rewritten against the same two private relation names.
        return {
            ok: true,
            value: {
                text: [
                    `CREATE TEMP TABLE ${quotePgIdentifier(parameters)} ON COMMIT DROP AS`,
                    `SELECT 1::integer AS "__present";`,
                ].join("\n"),
                values: [],
            },
        };
    }

    if (parameterNames.length !== argumentNames.length
        || parameterNames.some((name, index) => name !== argumentNames[index])) {
        return failure("migration arguments must match transformation parameters exactly");
    }
    if (context.storage === undefined || context.persistence === undefined) {
        return failure("typed parameters require persistence and storage context");
    }

    const representation = context.persistence.representations[context.storage.representation];
    if (representation === undefined) {
        return failure("physical type representation is missing", {representation: context.storage.representation});
    }

    const expressions: string[] = [];
    const values: (string | null)[] = [];
    for (let index = 0; index < parameterNames.length; index++) {
        const name = parameterNames[index]!;
        const domain = context.transformation.parameters[name]!;
        const argument = migration.arguments[name]!;
        if (!sameDomain(domain, argument.domain)) {
            return failure("migration argument domain does not match transformation parameter", {parameter: name});
        }
        if (argument.value === null && !domain.nullable) {
            return failure("non-null transformation parameter received null", {parameter: name});
        }

        const physicalName = representation[domain.type];
        if (typeof physicalName !== "string" || physicalName.length === 0) {
            return failure("physical type mapping is missing", {parameter: name, logicalType: domain.type});
        }
        const resolved = requireCodec(context.storage, physicalName);
        if (!resolved.ok) return resolved;
        const transportSql = pgTypeSql(resolved.value.transport);
        if (!transportSql.ok) return transportSql;
        const physicalSql = pgTypeSql(resolved.value.physical);
        if (!physicalSql.ok) return physicalSql;

        const placeholder = `$${index + 1}`;
        const transportCast = `${placeholder}::${transportSql.value}`;
        const expression = resolved.value.codec.transportType === physicalName
            ? transportCast
            : `${transportCast}::${physicalSql.value}`;
        expressions.push(`    ${expression} AS ${quotePgIdentifier(name)}`);
        values.push(argument.value);
    }

    return {
        ok: true,
        value: {
            text: [
                `CREATE TEMP TABLE ${quotePgIdentifier(parameters)} ON COMMIT DROP AS`,
                "SELECT",
                expressions.join(",\n") + ";",
            ].join("\n"),
            values,
        },
    };
}

function transformSql(output: string, rewritten: string): string {
    return [
        `CREATE TEMP TABLE ${quotePgIdentifier(output)} ON COMMIT DROP AS`,
        `${stripFinalSemicolon(rewritten)};`,
    ].join("\n");
}

function rowProtocolSql(input: string, output: string): string {
    const inputName = quotePgIdentifier(input);
    const outputName = quotePgIdentifier(output);
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
        `CREATE TEMP TABLE ${quotePgIdentifier(lineage)} ON COMMIT DROP AS`,
        `${stripFinalSemicolon(rewritten)};`,
    ].join("\n");
}

function setProtocolSql(input: string, output: string, lineage: string): string {
    const inputName = quotePgIdentifier(input);
    const outputName = quotePgIdentifier(output);
    const lineageName = quotePgIdentifier(lineage);
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
        `"target".${quotePgIdentifier(pair.targetField)} IS NOT DISTINCT FROM "output".${quotePgIdentifier(pair.output)}`
    )).join("\n    AND ");
}

function prewriteSql(
    write: Extract<WriteInfo, {kind: "update"}>,
    schema: string,
    output: string,
    identityColumn: "__source_id" | "__output_id",
): string {
    const cardinality = write.whenMissing === "insert" ? "> 1" : "<> 1";
    const clauses = [
        "EXISTS (",
        `    SELECT "output".${quotePgIdentifier(identityColumn)}`,
        `    FROM ${quotePgIdentifier(output)} AS "output"`,
        `    LEFT JOIN ${quotePgQualified(schema, write.entity)} AS "target"`,
        `      ON ${matchPredicate(write)}`,
        `    GROUP BY "output".${quotePgIdentifier(identityColumn)}`,
        `    HAVING count("target".ctid) ${cardinality}`,
        ")",
    ];
    if (write.whenMissing === "insert") {
        const matchOutputs = write.match.map(pair => `"output".${quotePgIdentifier(pair.output)}`).join(", ");
        clauses.push(
            "OR EXISTS (",
            `    SELECT ${matchOutputs}`,
            `    FROM ${quotePgIdentifier(output)} AS "output"`,
            `    GROUP BY ${matchOutputs}`,
            "    HAVING count(*) > 1",
            ")",
        );
    }
    return [
        "SELECT 1 / CASE WHEN (",
        ...clauses.map(line => `    ${line}`),
        ` ) THEN 0 ELSE 1 END AS "update_match_ok";`,
    ].join("\n");
}

function updateSql(
    write: Extract<WriteInfo, {kind: "update"}>,
    schema: string,
    output: string,
): string {
    const assignments = write.values.map(binding => (
        `${quotePgIdentifier(binding.target.field)} = "output".${quotePgIdentifier(binding.output)}`
    )).join(",\n    ");
    return [
        `UPDATE ${quotePgQualified(schema, write.entity)} AS "target"`,
        "SET " + assignments,
        `FROM ${quotePgIdentifier(output)} AS "output"`,
        `WHERE ${matchPredicate(write)};`,
    ].join("\n");
}


type DestinationOutput = {targetField: string; output: string};

function insertValueBindings(write: Extract<WriteInfo, {kind: "insert"}>): readonly DestinationOutput[] {
    return write.values.map(binding => ({targetField: binding.target.field, output: binding.output}));
}

function missingUpdateInsertBindings(write: Extract<WriteInfo, {kind: "update"}>): readonly DestinationOutput[] {
    const byField = new Map<string, DestinationOutput>();
    for (const pair of write.match) {
        byField.set(pair.targetField, {targetField: pair.targetField, output: pair.output});
    }
    for (const binding of write.values) {
        byField.set(binding.target.field, {targetField: binding.target.field, output: binding.output});
    }
    return [...byField.values()];
}

function destinationOutputForField(bindings: readonly DestinationOutput[], field: string): string {
    const binding = bindings.find(item => item.targetField === field);
    if (binding === undefined) throw new Error(`validated destination binding is missing for ${field}`);
    return binding.output;
}

function keyMatchPredicate(
    fields: readonly string[],
    bindings: readonly DestinationOutput[],
): string {
    return fields.map(field => (
        `"target".${quotePgIdentifier(field)} IS NOT DISTINCT FROM "output".${quotePgIdentifier(destinationOutputForField(bindings, field))}`
    )).join("\n    AND ");
}

function insertConflictSql(
    write: Extract<WriteInfo, {kind: "insert"}>,
    schema: string,
    output: string,
): string {
    const bindings = insertValueBindings(write);
    const grouped = write.key.map(field => `"output".${quotePgIdentifier(destinationOutputForField(bindings, field))}`).join(", ");
    return [
        "SELECT 1 / CASE WHEN (",
        "    EXISTS (",
        `        SELECT ${grouped}`,
        `        FROM ${quotePgIdentifier(output)} AS "output"`,
        `        GROUP BY ${grouped}`,
        "        HAVING count(*) > 1",
        "    )",
        "    OR EXISTS (",
        `        SELECT 1 FROM ${quotePgIdentifier(output)} AS "output"`,
        `        JOIN ${quotePgQualified(schema, write.entity)} AS "target"`,
        `          ON ${keyMatchPredicate(write.key, bindings)}`,
        "    )",
        ` ) THEN 0 ELSE 1 END AS "insert_conflict_ok";`,
    ].join("\n");
}

function insertSql(
    entity: string,
    schema: string,
    output: string,
    bindings: readonly DestinationOutput[],
    missingPredicate: string | null = null,
): string {
    const targets = bindings.map(binding => quotePgIdentifier(binding.targetField)).join(", ");
    const values = bindings.map(binding => `"output".${quotePgIdentifier(binding.output)}`).join(", ");
    const lines = [
        `INSERT INTO ${quotePgQualified(schema, entity)} (${targets})`,
        `SELECT ${values}`,
        `FROM ${quotePgIdentifier(output)} AS "output"`,
    ];
    if (missingPredicate !== null) {
        lines.push(
            "WHERE NOT EXISTS (",
            `    SELECT 1 FROM ${quotePgQualified(schema, entity)} AS "target"`,
            `    WHERE ${missingPredicate.replaceAll("\n", "\n    ")}`,
            ")",
        );
    }
    lines[lines.length - 1] = lines[lines.length - 1] + ";";
    return lines.join("\n");
}


type PreservedEntity = {
    entity: string;
    table: string;
    contract: DestinationContract;
    writes: readonly WriteInfo[];
    identityFields: readonly string[];
};

function preservationTableName(stem: string, entity: string): string {
    const suffix = createHash("sha256").update(entity, "utf8").digest("hex").slice(0, 10);
    return `${stem}_before_${suffix}`;
}

function preservationContracts(
    migration: DataMigrationInfo,
    context: CompileDataContext,
    stem: string,
): ValidationResult<readonly PreservedEntity[]> {
    if (context.targetSnapshot === undefined || context.targetSchema === undefined) {
        return {ok: true, value: []};
    }
    const order: string[] = [];
    const byEntity = new Map<string, WriteInfo[]>();
    for (const write of migration.writes) {
        let writes = byEntity.get(write.entity);
        if (writes === undefined) {
            writes = [];
            byEntity.set(write.entity, writes);
            order.push(write.entity);
        }
        writes.push(write);
    }
    const result: PreservedEntity[] = [];
    for (const entity of order) {
        const contract = destinationContract(context, entity);
        if (!contract.ok) return contract;
        const writes = byEntity.get(entity)!;
        const changedFields = new Set(
            writes.flatMap(write => write.kind === "update"
                ? write.values.map(binding => binding.target.field)
                : []),
        );
        const candidateKeys = [contract.value.entity.pk, ...Object.values(contract.value.entity.uks)];
        const identityFields = candidateKeys.find(key => key.length > 0 && key.every(field => !changedFields.has(field)));
        if (identityFields === undefined) {
            return failure("conservation requires a destination key that remains unchanged across writes", {entity});
        }
        result.push({
            entity,
            table: preservationTableName(stem, entity),
            contract: contract.value,
            writes,
            identityFields,
        });
    }
    return {ok: true, value: result};
}

function preserveDestinationSql(
    preserved: PreservedEntity,
    schema: string,
): string {
    const fields = Object.keys(preserved.contract.entity.fields).sort(compareUtf16);
    const projection = fields.map(field => quotePgIdentifier(field)).join(", ");
    return [
        `CREATE TEMP TABLE ${quotePgIdentifier(preserved.table)} ON COMMIT DROP AS`,
        `SELECT TRUE AS "__before_present", ${projection}`,
        `FROM ${quotePgQualified(schema, preserved.entity)};`,
    ].join("\n");
}

function targetOutputPredicate(
    pairs: readonly {targetField: string; output: string}[],
    targetAlias: string,
    outputAlias: string,
): string {
    return pairs.map(pair => (
        `${quotePgIdentifier(targetAlias)}.${quotePgIdentifier(pair.targetField)} IS NOT DISTINCT FROM `
        + `${quotePgIdentifier(outputAlias)}.${quotePgIdentifier(pair.output)}`
    )).join("\n    AND ");
}

function writeBindings(write: WriteInfo): readonly DestinationOutput[] {
    return write.kind === "insert" ? insertValueBindings(write) : write.values.map(binding => ({
        targetField: binding.target.field,
        output: binding.output,
    }));
}

function writeScopeBindings(write: WriteInfo): readonly DestinationOutput[] {
    if (write.kind === "insert") {
        const all = insertValueBindings(write);
        return write.key.map(field => ({
            targetField: field,
            output: destinationOutputForField(all, field),
        }));
    }
    return write.match.map(pair => ({targetField: pair.targetField, output: pair.output}));
}

function writtenValuesVerificationSql(
    write: WriteInfo,
    schema: string,
    output: string,
): string {
    const scope = writeScopeBindings(write);
    const bindings = writeBindings(write);
    const mismatch = bindings.map(binding => (
        `"target".${quotePgIdentifier(binding.targetField)} IS DISTINCT FROM "output".${quotePgIdentifier(binding.output)}`
    )).join("\n            OR ");
    return [
        "SELECT 1 / CASE WHEN EXISTS (",
        `    SELECT 1 FROM ${quotePgIdentifier(output)} AS "output"`,
        `    LEFT JOIN ${quotePgQualified(schema, write.entity)} AS "target"`,
        `      ON ${targetOutputPredicate(scope, "target", "output")}`,
        "    WHERE \"target\".ctid IS NULL",
        mismatch.length === 0 ? "" : `       OR (${mismatch})`,
        `) THEN 0 ELSE 1 END AS "${write.kind}_written_values_ok";`,
    ].filter(Boolean).join("\n");
}

function pgRowIdentityPredicate(
    fields: readonly string[],
    leftAlias: string,
    rightAlias: string,
): string {
    return fields.map(field => (
        `${quotePgIdentifier(leftAlias)}.${quotePgIdentifier(field)} IS NOT DISTINCT FROM `
        + `${quotePgIdentifier(rightAlias)}.${quotePgIdentifier(field)}`
    )).join("\n            AND ");
}

function outputScopeForBeforeRow(write: Extract<WriteInfo, {kind: "update"}>): string {
    const pairs = write.match.map(pair => ({targetField: pair.targetField, output: pair.output}));
    return [
        "EXISTS (",
        '                SELECT 1 FROM __OUTPUT__ AS "output"',
        `                WHERE ${targetOutputPredicate(pairs, "before", "output").replaceAll("\n", "\n                ")}`,
        "            )",
    ].join("\n");
}

function allowedChangedFieldExpression(
    field: string,
    writes: readonly WriteInfo[],
    output: string,
): string | null {
    const scopes: string[] = [];
    for (const write of writes) {
        if (write.kind !== "update") continue;
        if (!write.values.some(binding => binding.target.field === field)) continue;
        scopes.push(outputScopeForBeforeRow(write).replaceAll("__OUTPUT__", quotePgIdentifier(output)));
    }
    if (scopes.length === 0) return null;
    return scopes.length === 1 ? scopes[0]! : `(${scopes.join("\n            OR ")})`;
}

function newRowAllowedExpression(write: WriteInfo, output: string): string | null {
    if (write.kind === "update" && write.whenMissing !== "insert") return null;
    const scope = writeScopeBindings(write);
    return [
        "EXISTS (",
        `                SELECT 1 FROM ${quotePgIdentifier(output)} AS "output"`,
        `                WHERE ${targetOutputPredicate(scope, "after", "output").replaceAll("\n", "\n                ")}`,
        "            )",
    ].join("\n");
}

function preservationVerificationSql(
    preserved: PreservedEntity,
    schema: string,
    output: string,
): string {
    const fields = Object.keys(preserved.contract.entity.fields).sort(compareUtf16);
    const identityFields = preserved.identityFields;
    const changedChecks = fields.map(field => {
        const allowance = allowedChangedFieldExpression(field, preserved.writes, output);
        if (allowance === null) {
            return `"before".${quotePgIdentifier(field)} IS DISTINCT FROM "after".${quotePgIdentifier(field)}`;
        }
        return [
            "(",
            `    "before".${quotePgIdentifier(field)} IS DISTINCT FROM "after".${quotePgIdentifier(field)}`,
            `    AND NOT (${allowance.replaceAll("\n", "\n    ")})`,
            ")",
        ].join("\n");
    });
    const newRowAllowances = preserved.writes
        .map(write => newRowAllowedExpression(write, output))
        .filter((value): value is string => value !== null);
    const newRowUnexpected = newRowAllowances.length === 0
        ? '"before"."__before_present" IS NULL'
        : [
            '"before"."__before_present" IS NULL',
            `AND NOT (${newRowAllowances.join("\n            OR ")})`,
        ].join("\n            ");

    return [
        "SELECT 1 / CASE WHEN EXISTS (",
        `    SELECT 1 FROM ${quotePgIdentifier(preserved.table)} AS "before"`,
        `    FULL JOIN ${quotePgQualified(schema, preserved.entity)} AS "after"`,
        `      ON ${pgRowIdentityPredicate(identityFields, "before", "after")}`,
        "    WHERE (",
        '        "before"."__before_present" IS NOT NULL AND "after".ctid IS NULL',
        "    ) OR (",
        `        ${newRowUnexpected.replaceAll("\n", "\n        ")}`,
        "    ) OR (",
        '        "before"."__before_present" IS NOT NULL AND "after".ctid IS NOT NULL',
        "        AND (",
        `            ${changedChecks.join("\n            OR ").replaceAll("\n", "\n            ")}`,
        "        )",
        "    )",
        `) THEN 0 ELSE 1 END AS "${preserved.entity}_before_preservation_ok";`,
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
    const parameterStatement = compileParameters(migration, context, temporary.parameters);
    if (!parameterStatement.ok) return parameterStatement;

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
        {phase: "parameters", text: parameterStatement.value.text, values: parameterStatement.value.values},
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

    const preserved = preservationContracts(migration, context, stem);
    if (!preserved.ok) return preserved;
    for (const entity of preserved.value) {
        statements.push({
            phase: "preserve",
            text: preserveDestinationSql(entity, context.schema),
            values: [],
        });
    }

    for (const write of migration.writes) {
        if (write.kind === "insert") {
            statements.push({
                phase: "prewrite",
                text: insertConflictSql(write, context.schema, temporary.output),
                values: [],
            });
            statements.push({
                phase: "write",
                text: insertSql(write.entity, context.schema, temporary.output, insertValueBindings(write)),
                values: [],
            });
            continue;
        }

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
        if (write.whenMissing === "insert") {
            const bindings = missingUpdateInsertBindings(write);
            statements.push({
                phase: "write",
                text: insertSql(
                    write.entity,
                    context.schema,
                    temporary.output,
                    bindings,
                    keyMatchPredicate(write.match.map(pair => pair.targetField), bindings),
                ),
                values: [],
            });
        }
    }

    for (const write of migration.writes) {
        statements.push({
            phase: "verify",
            text: writtenValuesVerificationSql(write, context.schema, temporary.output),
            values: [],
        });
    }
    for (const entity of preserved.value) {
        statements.push({
            phase: "verify",
            text: preservationVerificationSql(entity, context.schema, temporary.output),
            values: [],
        });
    }

    return {
        ok: true,
        value: {temporary, statements, conservationChecks: migration.conservationChecks},
    };
}

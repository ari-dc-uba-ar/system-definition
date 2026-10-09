import {createHash} from "node:crypto";
import {decodeContentRefInfo, isPlainObject, problem, type MigrationInfo, type ResourceRefInfo, type ValidationResult} from "system-definition";
import type {AuthoringRuntime, CompiledAuthoringInfo, MigrationDraftInfo, StructureChangeInfo} from "./authoring-contract";
import {compileDataMigration} from "./compile-data";
import {compileMachineEntityReadQuery, compileMachinePortReadQuery} from "./data-validation";
import {generateStructureSql} from "./generate-structure";
import {decodeDataMigration, type PortInfo, type SnapshotSide} from "./migration-authoring";
import {createPgAstTools} from "./pg-ast";
import {quotePgQualified} from "./pg-sql";
import type {PgSchemaInfo} from "./pg-schema";
import {validationArtifactEvidenceHash} from "./validation-artifact";
import {samePgIdentity} from "./pg-identity";

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
type Checkpoint = {afterStep: string; checks: readonly ResourceRefInfo[]; rows: readonly unknown[]};

function failed(reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.authoringInvalid", "blocking", {reason})]};
}

/** Compose executable resources using the existing data compiler and checkpoint engine. */
export async function compileGenerated(
    draft: MigrationDraftInfo, runtime: AuthoringRuntime,
    inspected: PgSchemaInfo, desired: PgSchemaInfo,
    residual: readonly StructureChangeInfo[], initial: CompiledAuthoringInfo,
): Promise<ValidationResult<CompiledAuthoringInfo>> {
    if (residual.length === 0 && draft.data.length === 0 && initial.migration.steps.length === 0) return {ok: true, value: initial};
    if (runtime.emitResource === undefined || runtime.inspectCompiled === undefined) {
        return failed("SQL generation requires an artifact sink and owned scratch replay");
    }
    const emit = runtime.emitResource.bind(runtime);
    const ast = await createPgAstTools();
    const operations = [...initial.operations];
    const checkpoints: Checkpoint[] = [...initial.checkpoints] as Checkpoint[];
    const queryResources = {...initial.queryResources};
    const capture: MigrationInfo["steps"][number][] = [];
    const write: MigrationInfo["steps"][number][] = [];
    const before = [...initial.migration.before];
    // Partition proofs run before any source can be destroyed, including manual steps.
    for (const decision of draft.decisions) if (decision.partitionCheck !== null
        && !before.some(check => check.name === decision.partitionCheck!.name && check.contentHash === decision.partitionCheck!.contentHash)) {
        before.push(decision.partitionCheck);
    }
    const loadedData = runtime.loadDataContext ? await runtime.loadDataContext() : undefined;
    if (loadedData !== undefined && !loadedData.ok) return loadedData;
    const data = loadedData?.value;
    const validationArtifacts = data?.validationArtifacts ?? initial.validationArtifacts;

    // Manual checkpoints use the same immutable query-resource registry as generated ones.
    for (const checkpoint of checkpoints) for (const row of checkpoint.rows) {
        if (!isPlainObject(row)) return failed("Malformed manual row checkpoint");
        const query = decodeContentRefInfo(row.select, "$", "query", (_path, reason) => failed(reason));
        if (!query.ok) return query;
        const text = await runtime.readQuery(query.value);
        if (!text.ok) return text;
        const file = await emit({ref: query.value, text: text.value});
        if (!file.ok) return file;
        queryResources[query.value.name] = {kind: "query", file: file.value};
    }

    async function sqlStep(id: string, text: string): Promise<ValidationResult<MigrationInfo["steps"][number]>> {
        const ref = {name: id + ".sql", kind: "sql" as const, contentHash: hash(text)};
        const stored = await emit({ref, text});
        if (!stored.ok) return stored;
        if (stored.value.contentHash !== ref.contentHash) return failed("Artifact sink returned a different SQL hash");
        return {ok: true, value: {id, run: ref}};
    }

    if (draft.data.length > 0) {
        if (data === undefined) return failed("Data compilation requires historical snapshots, transformations, codecs and validation artifacts");
        const byId = new Map(draft.data.map(migration => [migration.id, migration]));
        if (byId.size !== draft.data.length) return failed("Duplicate data migration id");
        const ordered: typeof draft.data[number][] = [];
        const remaining = new Map(byId);
        while (remaining.size > 0) {
            const ready = [...remaining.values()].filter(migration => migration.dependsOn.every(id => ordered.some(one => one.id === id)))
                .sort((a, b) => a.id < b.id ? -1 : 1);
            if (ready.length === 0) return failed("Unknown or cyclic data migration dependency");
            for (const migration of ready) { ordered.push(migration); remaining.delete(migration.id); }
        }
        // All sources are captured before any write. An explicit dependency orders overlapping destinations.
        const writers = new Map<string, string>();
        const reaches = (id: string, dependency: string): boolean =>
            byId.get(id)!.dependsOn.some(parent => parent === dependency || reaches(parent, dependency));
        for (const migration of ordered) {
            const decoded = decodeDataMigration(data.context, migration);
            if (!decoded.ok) return decoded;
            for (const destination of migration.writes) for (const binding of destination.values) {
                const key = JSON.stringify([destination.entity, binding.target.field]);
                const previous = writers.get(key);
                if (previous !== undefined && !reaches(migration.id, previous)) return failed("Overlapping data writers require an explicit dependency");
                writers.set(key, migration.id);
            }
            const transformation = data.context.transformations[migration.transformation];
            if (transformation === undefined) return failed("Unknown transformation");
            const source = await runtime.readQuery(migration.source.query);
            if (!source.ok) return source;
            const query = await runtime.readQuery(transformation.query);
            if (!query.ok) return query;
            const lineage = transformation.lineage === null ? null : await runtime.readQuery(transformation.lineage);
            if (lineage !== null && !lineage.ok) return lineage;
            const compiled = compileDataMigration(migration, {
                migrationId: draft.id, schema: data.storage.schema, transformation,
                sourceQuery: {ref: migration.source.query, text: source.value},
                transformationQuery: {ref: transformation.query, text: query.value},
                lineageQuery: lineage !== null && transformation.lineage !== null ? {ref: transformation.lineage, text: lineage.value} : null,
                relationRewriter: ast.relations, storage: data.storage, persistence: data.persistence,
                targetSnapshot: data.context.to, targetSchema: desired,
            });
            if (!compiled.ok) return compiled;
            const stepIds: string[] = [];
            for (let index = 0; index < compiled.value.statements.length; index++) {
                const statement = compiled.value.statements[index]!;
                const bound = ast.bind(statement.text, statement.values);
                if (!bound.ok) return bound;
                const id = `data:${migration.id}:${index}:${statement.phase}`;
                const step = await sqlStep(id, bound.value);
                if (!step.ok) return step;
                stepIds.push(id);
                (["capture", "parameters", "transform", "lineage", "protocol"].includes(statement.phase) ? capture : write).push(step.value);
            }
            // Validate captured inputs, bound parameters and ALL transformation outputs,
            // including outputs that are not eventually written to an entity column.
            for (const selection of [
                {phase: "capture", table: compiled.value.temporary.input, ports: migration.source.ports},
                {phase: "parameters", table: compiled.value.temporary.parameters,
                    ports: Object.fromEntries(Object.entries(transformation.parameters).map(([name, domain]) => [name, {domain, field: null}]))},
                {phase: "transform", table: compiled.value.temporary.output, ports: transformation.outputs},
            ]) for (const side of ["from", "to"] as const) {
                const ports: Readonly<Record<string, PortInfo>> = Object.fromEntries(Object.entries(selection.ports).filter(([, port]) => port.domain.side === side));
                if (Object.keys(ports).length === 0) continue;
                const artifact = data.validationArtifacts.find(one => one.side === side);
                if (!artifact) return failed("Missing historical port validator");
                const projected = compileMachinePortReadQuery(ports, data.persistence, data.storage,
                    `SELECT * FROM ${quotePgQualified("pg_temp", selection.table)}`, ast.machine);
                if (!projected.ok) return projected;
                const name = `validate:${migration.id}:${selection.phase}:${side}`;
                const ref = {name: name + ".sql", kind: "query" as const, contentHash: hash(projected.value)};
                const file = await emit({ref, text: projected.value});
                if (!file.ok) return file;
                queryResources[ref.name] = {kind: "query", file: file.value};
                const afterStep = stepIds[compiled.value.statements.findIndex(statement => statement.phase === selection.phase)]!;
                const row = {id: name, afterStep, side, ports, select: ref, validatorArtifactHash: validationArtifactEvidenceHash(artifact)};
                const existing = checkpoints.find(one => one.afterStep === afterStep);
                if (existing) existing.rows = [...existing.rows, row];
                else checkpoints.push({afterStep, checks: [], rows: [row]});
            }
            before.push(...migration.source.coverageChecks, ...transformation.before);
            checkpoints.push({afterStep: stepIds[stepIds.length - 1]!, checks: [...transformation.after, ...compiled.value.conservationChecks], rows: []});
            operations.push({id: "data:" + migration.id, stepIds, changeIds: [], dataMigrationIds: [migration.id]});
        }


    }

    const destinations = new Set(draft.data.flatMap(migration => migration.writes.flatMap(destination =>
        destination.values.map(binding => JSON.stringify([destination.entity, binding.target.field])))));
    const structure = generateStructureSql(residual, inspected, desired, destinations);
    if (!structure.ok) return structure;
    const prepare: MigrationInfo["steps"][number][] = [];
    const finish: MigrationInfo["steps"][number][] = [];
    for (const [index, statement] of structure.value.entries()) {
        const id = "structure:" + statement.change.id + ":" + index;
        const step = await sqlStep(id, statement.text);
        if (!step.ok) return step;
        (statement.order < 50 ? prepare : finish).push(step.value);
        operations.push({id, stepIds: [id], changeIds: [statement.change.id], dataMigrationIds: []});
    }
    for (const change of residual) {
        const object = [...inspected.objects, ...desired.objects].find(object => object.kind === "index"
            && [change.before, change.after].some(identity => identity !== null && samePgIdentity(identity, object.identity)));
        if (object?.kind !== "index" || object.ownerConstraint === null) continue;
        const owner = residual.find(one => [one.before, one.after].some(identity => identity !== null && samePgIdentity(identity, object.ownerConstraint!)));
        const operationIndex = operations.findIndex(operation => owner !== undefined && operation.changeIds.includes(owner.id));
        if (operationIndex < 0) return failed("Backing index has no generated owner operation");
        const operation = operations[operationIndex]!;
        operations[operationIndex] = {...operation, changeIds: [...operation.changeIds, change.id]};
    }
    if (data !== undefined && capture.length === 0) {
        const preflight = await sqlStep("validation:source", "SELECT 1;\n");
        if (!preflight.ok) return preflight;
        capture.push(preflight.value);
        operations.unshift({id: "validation:source", stepIds: [preflight.value.id], changeIds: [], dataMigrationIds: []});
    }
    const allSteps = [...capture, ...initial.migration.steps, ...prepare, ...write, ...finish];
    if (data !== undefined) {
        // Query complete entities, including untouched fields, using their historical codecs.
        for (const side of ["from", "to"] as const satisfies readonly SnapshotSide[]) {
            const artifact = data.validationArtifacts.find(one => one.side === side);
            const expectedHash = side === "from" ? draft.base.fromSnapshotHash : draft.base.toSnapshotHash;
            if (artifact === undefined || artifact.snapshotHash !== expectedHash) return failed("Missing or mismatched historical validation artifact");
            const afterStep = side === "from" ? capture[0]!.id : (write[write.length - 1] ?? allSteps[allSteps.length - 1])!.id;
            const rows: unknown[] = [];
            for (const entity of Object.keys(data.context[side].entities).sort()) {
                const projected = compileMachineEntityReadQuery(data.context[side], entity, data.persistence, data.storage,
                    `SELECT * FROM ${quotePgQualified(data.storage.schema, entity)}`, ast.machine);
                if (!projected.ok) return projected;
                const ref = {name: `validate:${side}:${entity}.sql`, kind: "query" as const, contentHash: hash(projected.value)};
                const file = await emit({ref, text: projected.value});
                if (!file.ok) return file;
                queryResources[ref.name] = {kind: "query", file: file.value};
                rows.push({id: `validate:${side}:${entity}`, afterStep, side, entity, select: ref, validatorArtifactHash: validationArtifactEvidenceHash(artifact)});
            }
            const existing = checkpoints.find(one => one.afterStep === afterStep);
            if (existing !== undefined) existing.rows = [...existing.rows, ...rows];
            else checkpoints.push({afterStep, checks: [], rows});
        }
    }
    const compiled: CompiledAuthoringInfo = {
        ...initial, operations, checkpoints, queryResources, validationArtifacts,
        migration: {...initial.migration, before, steps: allSteps},
    };
    const replayed = await runtime.inspectCompiled(compiled);
    if (!replayed.ok) return replayed;
    const {inferStructureChanges} = await import("./infer.js");
    const remaining = inferStructureChanges(draft.base, replayed.value, desired, []);
    if (!remaining.ok) return remaining;
    if (remaining.value.length > 0) return failed("Combined SQL replay did not reach the requested SSOT");
    return {ok: true, value: compiled};
}

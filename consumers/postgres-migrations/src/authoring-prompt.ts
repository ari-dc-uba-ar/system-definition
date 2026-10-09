import type {JsonValue, ValidationResult} from "system-definition";
import {problem} from "system-definition";
import type {AuthoringFiles} from "./authoring-files";
import {buildSourceSelection, type SourceFieldSelection} from "./source-selection";
import {decodeDataMigration, type AuthoringContext, type DataMigrationInfo, type MachineValueInfo, type OutputBindingInfo, type MatchPairInfo} from "./migration-authoring";

/** Terminal I/O stays outside the serializable contracts and their validation owner. */
export async function promptDataMigration(
    context: AuthoringContext, schema: string, files: AuthoringFiles,
    ask: (question: string) => Promise<string>,
): Promise<ValidationResult<DataMigrationInfo>> {
    async function choose(label: string, choices: readonly string[]): Promise<string> {
        if (choices.length === 0) throw new Error(`No compatible choices for ${label}`);
        const selected = await ask(`${label} [${choices.join(", ")}]: `);
        if (!choices.includes(selected)) throw new Error(`Invalid ${label}: ${selected}`);
        return selected;
    }
    try {
        const id = await ask("Data migration id: ");
        const transformationName = await choose("Transformation", Object.keys(context.transformations).sort());
        const transformation = context.transformations[transformationName]!;
        const entity = await choose("Source entity", Object.keys(context.from.entities).sort());
        const fields = context.from.entities[entity]!.fields;
        const ports: Record<string, SourceFieldSelection> = {};
        for (const [name, input] of Object.entries(transformation.inputs)) {
            const choices = Object.entries(fields).filter(([, field]) => field.type === input.domain.type
                && (input.domain.nullable || !field.nullable)).map(([name]) => name);
            ports[name] = {alias: "source", field: await choose(`Source column for ${name} (${input.domain.type})`, choices)};
        }
        const identity = (await ask(`Source identity ports (comma separated, from ${Object.keys(ports).join(", ")}): `)).split(",").map(value => value.trim());
        const source = buildSourceSelection(context, {queryName: `${id}:source`, schema, base: {entity, alias: "source"},
            joins: [], ports, identity, coverageChecks: []});
        if (!source.ok) return source;
        const argumentsByName: Record<string, MachineValueInfo> = {};
        for (const [name, domain] of Object.entries(transformation.parameters)) {
            const value: JsonValue = JSON.parse(await ask(`Parameter ${name} (${domain.type}), JSON string or null: `));
            if (value !== null && typeof value !== "string") throw new Error("Parameters use machine strings or null");
            argumentsByName[name] = {domain, value};
        }
        const destination = await choose("Destination entity", Object.keys(context.to.entities).sort());
        const target = context.to.entities[destination]!;
        const kind = await choose("Write mode", ["update", "insert"]);
        const values: OutputBindingInfo[] = [];
        for (const [output, port] of Object.entries(transformation.outputs)) {
            const choices = Object.entries(target.fields).filter(([, field]) => field.type === port.domain.type
                && (field.nullable || !port.domain.nullable)).map(([name]) => name);
            const field = await choose(`Destination column for ${output} (${port.domain.type})`, [...choices, "(skip)"]);
            if (field !== "(skip)") values.push({output, target: {side: "to", entity: destination, field}});
        }
        const match: MatchPairInfo[] = [];
        if (kind === "update") for (const targetField of target.pk) {
            const choices = Object.entries(transformation.outputs).filter(([, output]) =>
                output.domain.type === target.fields[targetField]!.type && !output.domain.nullable).map(([name]) => name);
            match.push({targetField, output: await choose(`Output matching destination key ${targetField}`, choices)});
        }
        const decoded = decodeDataMigration(context, {
            id, description: await ask("Description: "), dependsOn: [], source: source.value.selection,
            transformation: transformationName, arguments: argumentsByName,
            writes: [kind === "insert" ? {kind, entity: destination, values, key: target.pk}
                : {kind, entity: destination, values, match, whenMissing: "error"}], conservationChecks: [],
        });
        if (!decoded.ok) return decoded;
        const emitted = await files.emitResource({ref: source.value.selection.query, text: source.value.sql});
        return emitted.ok ? decoded : emitted;
    } catch (error) {
        return {ok: false, problems: [problem(null, "migration.authoringInvalid", "blocking", {reason: error instanceof Error ? error.message : String(error)})]};
    }
}

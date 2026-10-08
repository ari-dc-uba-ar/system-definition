import {
    behaviourOf, problem, validateInstance,
    type Problem, type SystemSnapshotInfo, type SystemTypeContext, type ValidatorCollection,
} from "system-definition";
import type {PortInfo} from "./migration-authoring";
import type {ValidationModule} from "./validation-artifact";

/** Machine transport preserves null, empty text and the text "null" as different values. */
export function createHistoricalValidation(
    snapshot: SystemSnapshotInfo, snapshotHash: string,
    context: SystemTypeContext, validators: ValidatorCollection,
): ValidationModule {
    function convert(ports: Readonly<Record<string, PortInfo>>, values: Readonly<Record<string, string | null>>) {
        const problems: Problem[] = [];
        const converted: Record<string, unknown> = {};
        for (const [name, port] of Object.entries(ports)) {
            const raw = values[name];
            if (raw === null) {
                converted[name] = null;
                if (!port.domain.nullable) problems.push(problem(name, "field.required", "blocking"));
            } else if (typeof raw !== "string") {
                problems.push(problem(name, "field.required", "blocking"));
            } else {
                const behaviour = behaviourOf(context, port.domain.type);
                const parsed = behaviour.deserialize(raw);
                if (!parsed.ok) problems.push(problem(name, parsed.messageKey, "blocking"));
                else {
                    converted[name] = parsed.value;
                    if (!behaviour.check(parsed.value)) problems.push(problem(name, "field.notOfItsType", "blocking"));
                }
            }
        }
        return {problems, converted};
    }
    return {
        abi: "migration-validation-1", snapshotHash,
        validatePorts(ports, values) { return convert(ports, values).problems; },
        validateEntityRow(entity, values) {
            const info = snapshot.entities[entity];
            if (info === undefined) return [problem(null, "migration.invalidReference", "blocking", {entity})];
            const ports = Object.fromEntries(Object.entries(info.fields).map(([name, field]) => [name, {
                domain: {side: "to" as const, type: field.type, nullable: field.nullable}, field: null,
            }]));
            const decoded = convert(ports, values);
            if (decoded.problems.length > 0) return decoded.problems;
            return validateInstance(validators, info.validators, decoded.converted);
        },
    };
}

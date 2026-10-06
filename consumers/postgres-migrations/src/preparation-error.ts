import {problem, type ValidationResult} from "system-definition";

export function invalidPreparation<T>(
    reason: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {
        ok: false,
        problems: [problem(null, "migration.invalidPreparation", "blocking", {reason, ...details})],
    };
}

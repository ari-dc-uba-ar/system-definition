import {childPath, exactKeys, isNonEmptyString, isPlainObject, type StructuralFailure} from "./decode-structure";

/* A problem is never a text: it carries the message key, so the wording is resolved
   where the language is known (multilang, later). `details` holds whatever the message
   needs interpolated. */

export type Severity =
    /* the value could not even be understood, so the rules that use it cannot run:
       everything after this stage is skipped */
    | 'blocking'
    /* a rule was broken, but the rest of the rules still make sense and must run,
       so the user sees every problem at once instead of correcting one at a time */
    | 'regular'

export type Problem = {
    /* the field the problem belongs to, or null when it belongs to the whole record */
    field: string | null
    messageKey: string
    severity: Severity
    details: Readonly<Record<string, string>>
}

export type ValidationResult<TValue> =
    | {ok: true, value: TValue}
    | {ok: false, problems: readonly Problem[]}

export function problem(
    field: string | null,
    messageKey: string,
    severity: Severity,
    details: Readonly<Record<string, string>> = {},
): Problem {
    return {field, messageKey, severity, details};
}

export function hasBlocking(problems: readonly Problem[]): boolean {
    return problems.some(one => one.severity === 'blocking');
}


export function decodeProblem(
    value: unknown,
    path: string,
    invalid: StructuralFailure,
): ValidationResult<Problem> {
    if (!isPlainObject(value)) return invalid(path, "expected a problem");
    const shape = exactKeys(value, ["field", "messageKey", "severity", "details"], path, invalid);
    if (!shape.ok) return shape;
    if (!(value.field === null || typeof value.field === "string")) {
        return invalid(childPath(path, "field"), "problem field must be a string or null");
    }
    if (!isNonEmptyString(value.messageKey)) {
        return invalid(childPath(path, "messageKey"), "problem messageKey must not be empty");
    }
    if (value.severity !== "blocking" && value.severity !== "regular") {
        return invalid(childPath(path, "severity"), "unsupported problem severity");
    }
    if (!isPlainObject(value.details)) {
        return invalid(childPath(path, "details"), "problem details must be an object");
    }
    const details: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, detail] of Object.entries(value.details)) {
        if (typeof detail !== "string") {
            return invalid(childPath(childPath(path, "details"), key), "problem detail must be a string");
        }
        details[key] = detail;
    }
    return {
        ok: true,
        value: {field: value.field, messageKey: value.messageKey, severity: value.severity, details},
    };
}

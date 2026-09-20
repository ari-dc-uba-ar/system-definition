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

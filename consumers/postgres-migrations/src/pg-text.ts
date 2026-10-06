import {isNonEmptyString} from "system-definition";

/** PostgreSQL text values cannot contain NUL; keep that boundary refinement out of generic strings. */
export function isPgNonEmptyText(value: unknown): value is string {
    return isNonEmptyString(value) && !value.includes("\0");
}

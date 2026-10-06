/** PostgreSQL SQL-syntax primitives shared by all SQL emitters. */
export function isPgIdentifierText(value: unknown): value is string {
    return typeof value === "string" && !value.includes("\0");
}

export function quotePgIdentifier(identifier: string): string {
    if (!isPgIdentifierText(identifier)) {
        throw new TypeError("PostgreSQL identifiers cannot contain NUL");
    }
    return '"' + identifier.replaceAll('"', '""') + '"';
}

export function quotePgQualified(left: string, right: string): string {
    return quotePgIdentifier(left) + "." + quotePgIdentifier(right);
}

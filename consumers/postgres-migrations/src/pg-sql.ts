/** PostgreSQL SQL-syntax primitives shared by all SQL emitters. */
export function quotePgIdentifier(identifier: string): string {
    if (identifier.includes("\0")) {
        throw new TypeError("PostgreSQL identifiers cannot contain NUL");
    }
    return '"' + identifier.replaceAll('"', '""') + '"';
}

export function quotePgQualified(left: string, right: string): string {
    return quotePgIdentifier(left) + "." + quotePgIdentifier(right);
}

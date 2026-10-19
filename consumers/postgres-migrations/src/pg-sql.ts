/** PostgreSQL SQL-syntax primitives shared by all SQL emitters. */
export function isPgIdentifierText(value: unknown): value is string {
    return typeof value === "string" && !value.includes("\0");
}

/** Names stored by the server must survive PostgreSQL's identifier length limit. */
export function isPgStoredIdentifier(value: unknown): value is string {
    return isPgIdentifierText(value) && value.length > 0 && new TextEncoder().encode(value).byteLength <= 63;
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

export function quotePgLiteral(value: string): string {
    return "'" + value.replaceAll("'", "''") + "'";
}

export function constraintTimingSql(deferrable: boolean, initiallyDeferred: boolean): string {
    return deferrable ? ` DEFERRABLE INITIALLY ${initiallyDeferred ? "DEFERRED" : "IMMEDIATE"}` : "";
}

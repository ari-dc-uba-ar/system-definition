import {
    problem,
    type ResourceRefInfo,
    type ValidationResult,
} from "system-definition";
import type {PgSession, ResolvedSqlResource} from "./pg-schema";

export type PreparedSqlStatement = {
    text: string;
};

export type PreparedSqlResource = {
    ref: ResourceRefInfo;
    statements: readonly PreparedSqlStatement[];
};

type ParsedStatement = PreparedSqlStatement & {
    words: readonly string[];
};

function fail<T>(
    messageKey: string,
    details: Readonly<Record<string, string>> = {},
): ValidationResult<T> {
    return {ok: false, problems: [problem(null, messageKey, "blocking", details)]};
}

function safeResourceRef(ref: ResourceRefInfo, expectedKind: ResourceRefInfo["kind"]): boolean {
    return typeof ref === "object" && ref !== null
        && typeof ref.name === "string" && ref.name.length > 0 && !ref.name.includes("\0")
        && ref.kind === expectedKind
        && typeof ref.contentHash === "string" && /^[0-9a-f]{64}$/.test(ref.contentHash);
}

function dollarTagAt(text: string, start: number): string | null {
    if (text[start] !== "$") return null;
    let index = start + 1;
    while (index < text.length && text[index] !== "$") {
        const code = text.charCodeAt(index);
        const alphaNumeric = (code >= 48 && code <= 57)
            || (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || code === 95;
        if (!alphaNumeric) return null;
        index++;
    }
    if (index >= text.length || text[index] !== "$") return null;
    return text.slice(start, index + 1);
}

function parseSql(text: string): ValidationResult<readonly ParsedStatement[]> {
    if (typeof text !== "string" || text.trim().length === 0) {
        return fail("migration.unsupportedSql", {reason: "SQL resource must contain at least one statement"});
    }
    if (text.startsWith("\uFEFF") || text.includes("\r") || text.includes("\0")) {
        return fail("migration.unsupportedSql", {reason: "SQL resource has unsupported bytes/line endings"});
    }

    const statements: ParsedStatement[] = [];
    let statementStart = 0;
    let words: string[] = [];
    let word = "";
    let index = 0;
    let mode: "normal" | "single" | "double" | "lineComment" | "blockComment" | "dollar" = "normal";
    let blockDepth = 0;
    let dollarTag = "";

    const flushWord = (): void => {
        if (word.length > 0) {
            words.push(word.toLowerCase());
            word = "";
        }
    };
    const pushStatement = (end: number): void => {
        flushWord();
        const value = text.slice(statementStart, end).trim();
        if (value.length > 0 && words.length > 0) {
            statements.push({text: value, words});
        }
        words = [];
        statementStart = end + 1;
    };

    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];

        if (mode === "single") {
            if (char === "\\" && index + 1 < text.length) {
                index += 2;
                continue;
            }
            if (char === "'" && next === "'") {
                index += 2;
                continue;
            }
            if (char === "'") mode = "normal";
            index++;
            continue;
        }
        if (mode === "double") {
            if (char === '"' && next === '"') {
                index += 2;
                continue;
            }
            if (char === '"') mode = "normal";
            index++;
            continue;
        }
        if (mode === "lineComment") {
            if (char === "\n") mode = "normal";
            index++;
            continue;
        }
        if (mode === "blockComment") {
            if (char === "/" && next === "*") {
                blockDepth++;
                index += 2;
                continue;
            }
            if (char === "*" && next === "/") {
                blockDepth--;
                index += 2;
                if (blockDepth === 0) mode = "normal";
                continue;
            }
            index++;
            continue;
        }
        if (mode === "dollar") {
            if (text.startsWith(dollarTag, index)) {
                index += dollarTag.length;
                mode = "normal";
                continue;
            }
            index++;
            continue;
        }

        if (char === "'") {
            flushWord();
            mode = "single";
            index++;
            continue;
        }
        if (char === '"') {
            flushWord();
            mode = "double";
            index++;
            continue;
        }
        if (char === "-" && next === "-") {
            flushWord();
            mode = "lineComment";
            index += 2;
            continue;
        }
        if (char === "/" && next === "*") {
            flushWord();
            mode = "blockComment";
            blockDepth = 1;
            index += 2;
            continue;
        }
        if (char === "$") {
            const tag = dollarTagAt(text, index);
            if (tag !== null) {
                flushWord();
                dollarTag = tag;
                mode = "dollar";
                index += tag.length;
                continue;
            }
        }
        if (char === ";") {
            pushStatement(index);
            index++;
            continue;
        }

        const code = text.charCodeAt(index);
        const wordChar = (code >= 48 && code <= 57)
            || (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || code === 95 || code === 36;
        if (wordChar) word += char;
        else flushWord();
        index++;
    }

    if (mode === "single" || mode === "double" || mode === "blockComment" || mode === "dollar") {
        return fail("migration.unsupportedSql", {reason: "SQL resource contains an unterminated literal/comment"});
    }
    flushWord();
    const tail = text.slice(statementStart).trim();
    if (tail.length > 0 && words.length > 0) statements.push({text: tail, words});
    if (statements.length === 0) {
        return fail("migration.unsupportedSql", {reason: "SQL resource must contain at least one statement"});
    }
    return {ok: true, value: statements};
}

function hasSequenceEffect(words: readonly string[]): boolean {
    return words.includes("nextval") || words.includes("setval");
}

function isForbiddenStatement(words: readonly string[]): string | null {
    const first = words[0] ?? "";
    const second = words[1] ?? "";
    if (["begin", "commit", "end", "rollback", "abort", "savepoint"].includes(first)) {
        return "transaction control is not allowed inside a migration resource";
    }
    if (first === "release" && second === "savepoint") return "transaction control is not allowed inside a migration resource";
    if (first === "start" && second === "transaction") return "transaction control is not allowed inside a migration resource";
    if (first === "prepare" && second === "transaction") return "prepared transactions are not allowed inside a migration resource";
    if (first === "set" && second === "transaction") return "transaction control is not allowed inside a migration resource";
    if (first === "vacuum") return "VACUUM cannot run inside the migration transaction";
    if (first === "alter" && second === "system") return "ALTER SYSTEM is outside the migration transaction";
    if ((first === "create" || first === "drop") && (second === "database" || second === "tablespace")) {
        return "database/tablespace DDL is outside the migration transaction";
    }
    if (words.includes("concurrently")
        && (words.includes("index") || (first === "refresh" && second === "materialized"))) {
        return "CONCURRENTLY is not supported by the atomic migration engine";
    }
    if (hasSequenceEffect(words)) {
        return "nextval/setval have non-transactional sequence effects";
    }
    return null;
}

function prepare(
    resource: ResolvedSqlResource,
    expectedKind: ResourceRefInfo["kind"],
): ValidationResult<{ref: ResourceRefInfo; statements: readonly ParsedStatement[]}> {
    if (resource === null || typeof resource !== "object" || !safeResourceRef(resource.ref, expectedKind)) {
        return fail("migration.invalidReference", {reason: "resource reference has the wrong shape or kind"});
    }
    const parsed = parseSql(resource.text);
    if (!parsed.ok) return parsed;
    for (const statement of parsed.value) {
        const reason = isForbiddenStatement(statement.words);
        if (reason !== null) {
            return fail("migration.unsupportedSql", {name: resource.ref.name, reason});
        }
    }
    return {ok: true, value: {ref: {...resource.ref}, statements: parsed.value}};
}

export function prepareSqlResource(
    resource: ResolvedSqlResource,
): ValidationResult<PreparedSqlResource> {
    const prepared = prepare(resource, "sql");
    if (!prepared.ok) return prepared;
    return {
        ok: true,
        value: {
            ref: prepared.value.ref,
            statements: prepared.value.statements.map(one => ({text: one.text})),
        },
    };
}

export async function executePreparedSqlResource(
    session: PgSession,
    resource: PreparedSqlResource,
): Promise<ValidationResult<true>> {
    if (!safeResourceRef(resource.ref, "sql") || !Array.isArray(resource.statements) || resource.statements.length === 0) {
        return fail("migration.invalidReference", {reason: "invalid prepared SQL resource"});
    }
    for (const statement of resource.statements) {
        if (statement === null || typeof statement !== "object" || typeof statement.text !== "string" || statement.text.trim().length === 0) {
            return fail("migration.unsupportedSql", {reason: "invalid prepared SQL statement"});
        }
        try {
            await session.query(statement.text, []);
        } catch (error) {
            return fail("migration.executionFailed", {
                resource: resource.ref.name,
                reason: error instanceof Error ? error.message : "SQL statement failed",
            });
        }
    }
    return {ok: true, value: true};
}

export async function runCheckResource(
    session: PgSession,
    resource: ResolvedSqlResource,
): Promise<ValidationResult<true>> {
    const prepared = prepare(resource, "check");
    if (!prepared.ok) return prepared;
    if (prepared.value.statements.length !== 1) {
        return fail("migration.checkFailed", {name: resource.ref.name, reason: "check must contain exactly one statement"});
    }
    const statement = prepared.value.statements[0];
    const first = statement.words[0] ?? "";
    if (first !== "select" && first !== "with" && first !== "values") {
        return fail("migration.checkFailed", {name: resource.ref.name, reason: "check must be a query"});
    }
    const mutating = new Set(["insert", "update", "delete", "merge", "alter", "create", "drop", "truncate", "grant", "revoke", "call", "do", "copy"]);
    if (statement.words.some(word => mutating.has(word))) {
        return fail("migration.checkFailed", {name: resource.ref.name, reason: "check query must not mutate the database"});
    }

    let result: Awaited<ReturnType<PgSession["query"]>>;
    try {
        result = await session.query(statement.text, []);
    } catch (error) {
        return fail("migration.checkFailed", {
            name: resource.ref.name,
            reason: error instanceof Error ? error.message : "check query failed",
        });
    }
    if (result.rows.length !== 1) {
        return fail("migration.checkFailed", {name: resource.ref.name, reason: "check must return exactly one row"});
    }
    const row = result.rows[0];
    const keys = Object.keys(row);
    if (keys.length !== 1 || keys[0] !== "ok" || typeof row.ok !== "boolean") {
        return fail("migration.checkFailed", {name: resource.ref.name, reason: "check row must be exactly {ok:boolean}"});
    }
    if (!row.ok) {
        return fail("migration.checkFailed", {name: resource.ref.name, reason: "check returned false"});
    }
    return {ok: true, value: true};
}

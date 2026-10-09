import {loadModule, parseSync, deparseSync} from "pgsql-parser";
import {isPlainObject, problem, type ValidationResult} from "system-definition";
import type {RelationRewriter} from "./compile-data";
import type {MachineReadProjector} from "./data-validation";
import {quotePgIdentifier} from "./pg-sql";

function visit(value: unknown, change: (node: Record<string, unknown>) => void): void {
    if (Array.isArray(value)) {
        for (const child of value) visit(child, change);
    } else if (isPlainObject(value)) {
        change(value);
        for (const child of Object.values(value)) visit(child, change);
    }
}

function result(run: () => string): ValidationResult<string> {
    try { return {ok: true, value: run()}; }
    catch (error) {
        return {ok: false, problems: [problem(null, "migration.unsupportedSql", "blocking", {
            reason: error instanceof Error ? error.message : String(error),
        })]};
    }
}

function expression(sql: string): unknown {
    const tree = parseSync(`SELECT ${sql}`);
    return expressionTarget(tree).val;
}

function expressionTarget(tree: ReturnType<typeof parseSync>) {
    const statement = tree.stmts?.[0]?.stmt;
    if (tree.stmts?.length !== 1 || statement === undefined || !("SelectStmt" in statement)) throw new Error("Expected one SELECT");
    const node = statement.SelectStmt.targetList?.[0];
    if (node === undefined || !("ResTarget" in node) || node.ResTarget.val === undefined) throw new Error("Expected one expression");
    return node.ResTarget;
}

export async function createPgAstTools(): Promise<{
    relations: RelationRewriter;
    machine: MachineReadProjector;
    bind(sql: string, values: readonly unknown[]): ValidationResult<string>;
}> {
    await loadModule();
    return {
        relations: {rewrite: request => result(() => {
            const tree = parseSync(request.sql);
            const statement = tree.stmts?.[0]?.stmt;
            if (tree.stmts?.length !== 1 || statement === undefined || !("SelectStmt" in statement)) {
                throw new Error("A transformation must be one SELECT query");
            }
            visit(tree, node => {
                if (isPlainObject(node.CommonTableExpr)
                    && ["migration_input", "migration_parameters"].includes(String(node.CommonTableExpr.ctename))) {
                    throw new Error("A CTE cannot shadow a migration relation");
                }
                if (["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt", "IntoClause", "LockingClause", "intoClause", "lockingClause"].some(key => key in node)) {
                    throw new Error("A transformation must not mutate or lock its sources");
                }
                const relation = node.RangeVar;
                if (!isPlainObject(relation) || relation.schemaname !== undefined) return;
                if (relation.relname === "migration_input" || relation.relname === "migration_parameters") {
                    // Keep the logical implicit alias, so migration_input.field remains valid.
                    node.RangeVar = {...relation,
                        alias: relation.alias ?? {aliasname: relation.relname},
                        relname: request.relations[relation.relname], schemaname: "pg_temp"};
                }
            });
            return deparseSync(tree);
        })},
        machine: {project: request => result(() => {
            const projections = request.fields.map(field => {
                const value = expression(field.readExpression);
                visit(value, node => {
                    const column = node.ColumnRef;
                    if (!isPlainObject(column) || !Array.isArray(column.fields) || column.fields.length !== 1) return;
                    const only = column.fields[0];
                    if (isPlainObject(only) && isPlainObject(only.String) && only.String.sval === "migration_value") {
                        node.ColumnRef = {...column, fields: [{String: {sval: "row"}}, {String: {sval: field.sourceColumn}}]};
                    }
                });
                const tree = parseSync("SELECT NULL");
                const target = expressionTarget(tree);
                target.val = value as typeof target.val;
                const projected = deparseSync(tree).replace(/^SELECT\s+/iu, "").replace(/;\s*$/u, "");
                return `${projected} AS ${quotePgIdentifier(field.field)}`;
            });
            const source = deparseSync(parseSync(request.sql)).replace(/;\s*$/u, "");
            return `SELECT ${projections.join(", ")} FROM (${source}) AS "row";`;
        })},
        bind: (sql, values) => result(() => {
            if (values.length === 0) return sql;
            const tree = parseSync(sql);
            const used = new Set<number>();
            visit(tree, node => {
                if (!isPlainObject(node.ParamRef)) return;
                const number = node.ParamRef.number;
                if (typeof number !== "number" || number < 1 || number > values.length) throw new Error("Invalid SQL parameter");
                const value = values[number - 1];
                if (value !== null && typeof value !== "string") throw new Error("Expected a machine string or null parameter");
                used.add(number);
                delete node.ParamRef;
                node.A_Const = value === null ? {isnull: true} : {sval: {sval: value}};
            });
            if (used.size !== values.length) throw new Error("Unused SQL parameter");
            return deparseSync(tree);
        }),
    };
}

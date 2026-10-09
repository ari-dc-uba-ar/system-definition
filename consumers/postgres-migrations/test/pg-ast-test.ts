import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {createPgAstTools} from "../src/pg-ast";

describe("PostgreSQL AST adapters", () => {
    it("rewrites relation nodes while preserving text literals and implicit aliases", async () => {
        const ast = await createPgAstTools();
        const result = ast.relations.rewrite({sql: `SELECT migration_input.email, 'migration_input' AS literal FROM "migration_input"`,
            relations: {migration_input: "private_input", migration_parameters: "private_parameters"}});
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.match(result.value, /pg_temp.private_input AS migration_input/);
        assert.match(result.value, /'migration_input'/);
        assert.match(result.value, /migration_input.email/);
    });
    it("rejects CTE shadowing and hidden modifying statements", async () => {
        const ast = await createPgAstTools();
        for (const sql of [
            "WITH migration_input AS (SELECT 1) SELECT * FROM migration_input",
            "WITH erased AS (DELETE FROM app.students RETURNING *) SELECT * FROM erased",
            "SELECT * INTO app.hidden FROM migration_input",
        ]) assert.equal(ast.relations.rewrite({sql, relations: {migration_input: "i", migration_parameters: "p"}}).ok, false);
    });
    it("binds null, apostrophes and parameter-looking literal text without replacement", async () => {
        const ast = await createPgAstTools();
        const result = ast.bind("SELECT $1 AS a, $2 AS b, '$1' AS literal", ["O'Hara", null]);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.match(result.value, /'O''Hara'/);
        assert.match(result.value, /NULL AS b/);
        assert.match(result.value, /'\$1' AS literal/);
        assert.equal(ast.bind("SELECT $2", ["missing"]).ok, false);
    });
});

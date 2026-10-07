import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {generateCreate} from "../src/generate-create";
import type {PgSchemaInfo} from "../src/pg-schema";

describe("clean-create identity ordering", () => {
    it("preserves field-wise ordering for quoted identifiers", () => {
        const type = {
            schema: "pg_catalog",
            name: "text",
            modifiers: [],
            arrayDimensions: 0,
            collation: null,
        } as const;
        const table = (name: string) => ({
            kind: "table" as const,
            identity: {schema: "app", kind: "table", name, parentName: null, signature: []},
            persistence: name,
            relationKind: "r",
        });
        const column = (parentName: string) => ({
            kind: "column" as const,
            identity: {schema: "app", kind: "column", name: "id", parentName, signature: []},
            type,
            nullable: false,
            defaultExpression: null,
            identityDefinition: null,
            generatedDefinition: null,
        });
        const schema: PgSchemaInfo = {
            formatVersion: 1,
            engineVersion: "18.6",
            schemas: ["app"],
            objects: [table("a#"), column("a#"), table('a"'), column('a"')],
        };

        const plan = generateCreate(schema);
        assert.equal(plan.ok, true);
        if (!plan.ok) return;
        const tables = plan.value.statements.filter(one => one.phase === "table").map(one => one.text);
        assert.match(tables[0], /"a"""/);
        assert.match(tables[1], /"a#"/);
    });
});

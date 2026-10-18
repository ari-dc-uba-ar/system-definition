import {strict as assert} from "node:assert";
import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import {inspectSchema} from "../src/inspect-schema";
import {compareSchemas} from "../src/compare-schema";
import type {PgObjectInfo, PgSession} from "../src/pg-schema";

// Use an explicitly supplied disposable database. Never load application .env files here.
const connectionString = process.env.POSTGRES_HANDOFF_TEST_URL;
const integration = connectionString ? describe : describe.skip;

function value<T>(result: ValidationResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}

async function withScratchSchema(run: (session: PgSession, schema: string) => Promise<void>): Promise<void> {
    const client = new Client({connectionString});
    await client.connect();
    const schema = `handoff_typmod_${randomUUID().replaceAll("-", "")}`;
    const session: PgSession = {
        async query(text, parameters) {
            const result = await client.query<Record<string, unknown>>(text, [...parameters]);
            return {rows: result.rows, rowCount: result.rowCount};
        },
        async close() {throw new Error("The fixture owns this connection");},
    };
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query(`CREATE SCHEMA "${schema}"`);
        await run(session, schema);
    } finally {
        // All fixtures and changes are rolled back, including when an assertion fails.
        try {await client.query("ROLLBACK");} finally {await client.end();}
    }
}

function column(objects: readonly PgObjectInfo[], name: string): Extract<PgObjectInfo, {kind: "column"}> {
    const found = objects.find(object => object.kind === "column" && object.identity.name === name);
    assert.ok(found?.kind === "column", `Missing column ${name}`);
    return found;
}

integration("existing-schema handoff: PostgreSQL type modifiers", () => {
    it("retains bounded character, numeric and timestamp declarations read from real catalogs", async () => {
        await withScratchSchema(async (session, schema) => {
            await session.query(`CREATE TABLE "${schema}".items (
                label varchar(64), unbounded varchar, amount numeric(12, 2), recorded_at timestamp(3)
            )`, []);
            const observed = value(await inspectSchema(session, {schemas: [schema], excluded: []}));
            assert.deepEqual(observed.unknown, []);
            assert.deepEqual(column(observed.schema.objects, "label").type.modifiers, ["64"]);
            assert.deepEqual(column(observed.schema.objects, "unbounded").type.modifiers, []);
            assert.deepEqual(column(observed.schema.objects, "amount").type.modifiers, ["12", "2"]);
            assert.deepEqual(column(observed.schema.objects, "recorded_at").type.modifiers, ["3"]);
        });
    });

    it("detects varchar length drift even when all names and other attributes match", async () => {
        await withScratchSchema(async (session, schema) => {
            await session.query(`CREATE TABLE "${schema}".items (label varchar(64))`, []);
            const before = value(await inspectSchema(session, {schemas: [schema], excluded: []}));
            await session.query(`ALTER TABLE "${schema}".items ALTER COLUMN label TYPE varchar(128)`, []);
            const after = value(await inspectSchema(session, {schemas: [schema], excluded: []}));
            const compared = value(compareSchemas(before.schema, after));
            assert.equal(compared.equal, false, "A changed length must not be accepted as the recorded schema");
            assert.ok(compared.differences.some(difference =>
                difference.path.includes("label") && difference.path.includes("modifiers")));
        });
    });
});

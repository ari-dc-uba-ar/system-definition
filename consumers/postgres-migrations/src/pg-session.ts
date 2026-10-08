import {randomUUID} from "node:crypto";
import {Client, type ClientConfig} from "pg";
import {problem, type ValidationResult} from "system-definition";
import {checkPostgres18_6, type PgSession, type SqlParameter} from "./pg-schema";
import {quotePgIdentifier} from "./pg-sql";
import type {ScratchHandle, ScratchProvider} from "./verify";

/** One driver connection is retained for the complete transaction and its advisory lock. */
export async function connectPostgres(config: ClientConfig): Promise<PgSession> {
    const client = new Client(config);
    await client.connect();
    const session: PgSession = {
        async query(text: string, values: readonly SqlParameter[]) {
            const result = await client.query<Record<string, unknown>>(text, [...values]);
            return {rows: result.rows, rowCount: result.rowCount};
        },
        async close() { await client.end(); },
    };
    const supported = await checkPostgres18_6(session);
    if (!supported.ok) {
        await session.close();
        throw new Error(JSON.stringify(supported.problems));
    }
    return session;
}

/** Only databases allocated by this provider instance can be cleaned up by it. */
export function createPostgresScratch(config: ClientConfig, schemas: readonly string[]): ScratchProvider {
    const handles = new Set<ScratchHandle>();
    const connections = new Map<ScratchHandle, PgSession>();
    return {
        async create(): Promise<ValidationResult<ScratchHandle>> {
            const id = "sd_scratch_" + randomUUID().replaceAll("-", "");
            let admin: PgSession | undefined;
            let session: PgSession | undefined;
            let allocated = false;
            try {
                admin = await connectPostgres(config);
                await admin.query(`CREATE DATABASE ${quotePgIdentifier(id)} TEMPLATE template0`, []);
                allocated = true;
                const target: ClientConfig = {...config, database: id};
                if (target.connectionString !== undefined) {
                    const url = new URL(target.connectionString);
                    url.pathname = "/" + id;
                    target.connectionString = url.toString();
                }
                session = await connectPostgres(target);
                for (const schema of schemas) await session.query(`CREATE SCHEMA ${quotePgIdentifier(schema)}`, []);
                const handle = {id, session};
                handles.add(handle);
                connections.set(handle, admin);
                return {ok: true, value: handle};
            } catch (error) {
                await session?.close();
                if (allocated) await admin?.query(`DROP DATABASE ${quotePgIdentifier(id)}`, []);
                await admin?.close();
                return failure(error);
            }
        },
        owns(handle) { return handles.has(handle); },
        async destroy(handle) {
            if (!handles.has(handle)) return failure(new Error("Scratch handle is not owned by this provider"));
            const admin = connections.get(handle)!;
            try {
                await handle.session.close();
                await admin.query(`DROP DATABASE ${quotePgIdentifier(handle.id)}`, []);
                handles.delete(handle);
                connections.delete(handle);
                return {ok: true, value: true};
            } catch (error) { return failure(error); }
            finally { await admin.close(); }
        },
    };
}

function failure(error: unknown): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.executionFailed", "blocking", {
        reason: error instanceof Error ? error.message : String(error),
    })]};
}

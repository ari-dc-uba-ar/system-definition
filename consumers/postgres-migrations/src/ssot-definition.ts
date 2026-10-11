import type {SystemEntityContext, SystemSnapshotInput} from "system-definition";
import type {PgTypeRepresentation} from "./pg-schema";

/** Serializable PostgreSQL choices belong beside the domain definition.
 * Connections remain runtime environment settings, never part of this value. */
export type PostgresSystemDef<TContext extends SystemEntityContext> = SystemSnapshotInput<TContext> & {
    schema?: string;
    typeMappings?: Partial<Record<keyof TContext["types"] & string, PgTypeRepresentation>>;
};

/** The context holds behaviours; the definition contains only serializable data. */
export function definePostgresSystem<
    const TContext extends SystemEntityContext,
    const TDef extends PostgresSystemDef<TContext>,
>(context: TContext, definition: TDef): {context: TContext; definition: TDef} {
    return {context, definition};
}

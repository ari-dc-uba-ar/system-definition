import type {SystemSnapshotInfo} from "./system-snapshot";

/** Explicit storage choices. These do not infer domain validation or conversion. */
export const sqlTypes = {
    text: "text", varchar: "varchar", boolean: "boolean",
    smallint: "smallint", integer: "integer", bigint: "bigint",
    numeric: "numeric", real: "real", doublePrecision: "double precision",
    date: "date", time: "time", timestamp: "timestamp", timestampWithTimeZone: "timestamp with time zone",
    uuid: "uuid", json: "json", jsonb: "jsonb", bytea: "bytea",
} as const;

export type SqlType = typeof sqlTypes[keyof typeof sqlTypes];
export type SqlTypeMapping<S extends Pick<SystemSnapshotInfo, "typeNames">> = {
    readonly [K in S["typeNames"][number]]: SqlType;
};

export const POSTGRES_SUPPORT = {
    engine: "postgresql",
    version: "18.6",
    serverVersionNum: 180006,
} as const;

export type PostgresSupportInfo = typeof POSTGRES_SUPPORT;
export type PostgresEngine = PostgresSupportInfo["engine"];
export type PostgresVersion = PostgresSupportInfo["version"];
export type PostgresServerVersionNum = PostgresSupportInfo["serverVersionNum"];

export function matchesPostgresSupport(value: Readonly<Record<string, unknown>>): boolean {
    return value.engine === POSTGRES_SUPPORT.engine
        && value.version === POSTGRES_SUPPORT.version
        && value.serverVersionNum === POSTGRES_SUPPORT.serverVersionNum;
}

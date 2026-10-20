/** Recognize only the scoped controls used by catalog inspection in SQL session fakes. */
export function isInspectionControlSql(sql: string): boolean {
    return /^(?:(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) sd_inspect_[0-9a-f]{32}|SET LOCAL search_path = pg_catalog)$/.test(sql.trim());
}

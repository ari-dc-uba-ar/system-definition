import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import type {ValidationResult} from "system-definition";
import {decodeSqlSsot, type SqlSsotInfo} from "./sql-mapping";

export async function loadSsot(file: string): Promise<ValidationResult<SqlSsotInfo>> {
    const module = await import(pathToFileURL(resolve(file)).href);
    return decodeSqlSsot(module.ssot, module.sqlMapping);
}

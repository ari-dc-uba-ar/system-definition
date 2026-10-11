import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {decodeSystemSnapshot, type SystemSnapshotInfo, type ValidationResult} from "system-definition";

export async function loadSsot(file: string): Promise<ValidationResult<SystemSnapshotInfo>> {
    const module = await import(pathToFileURL(resolve(file)).href);
    return decodeSystemSnapshot(module.ssot);
}

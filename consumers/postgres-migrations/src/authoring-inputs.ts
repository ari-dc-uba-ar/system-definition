import {lstat, readFile, readdir, realpath, rmdir, unlink} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {decodeFileInfo, isPlainObject, type FileInfo, type ResourceRefInfo} from "system-definition";
import {isSafeArtifactPath} from "./artifact-files";
import {sha256Hex} from "./canonical-hash";
import type {MigrationDraftInfo} from "./authoring-contract";
import {invalidStore, jsonBytes, writeJsonAtomic} from "./migration-store";

type Inputs = {formatVersion: 1; draftId: string; answers: FileInfo[]};
const inputsFile = (draftFile: string) => draftFile + ".inputs.json";
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
function inside(root: string, path: string): boolean {
    const part = relative(resolve(root), resolve(path));
    return part !== "" && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
}

async function readInputs(draftFile: string, draftId: string): Promise<Inputs | undefined> {
    let raw: unknown;
    try {raw = JSON.parse(await readFile(inputsFile(draftFile), "utf8"));}
    catch (error) {if (missing(error)) return undefined; throw error;}
    if (!isPlainObject(raw) || raw.formatVersion !== 1 || raw.draftId !== draftId || !Array.isArray(raw.answers)) {
        throw new Error("Invalid migration authoring inputs: " + inputsFile(draftFile));
    }
    const answers: FileInfo[] = [];
    for (const item of raw.answers) {
        const file = decodeFileInfo(item, "answers", (_path, reason) => invalidStore(reason));
        if (!file.ok || !isSafeArtifactPath(file.value.path)) throw new Error("Invalid migration answers file reference");
        answers.push(file.value);
    }
    return {formatVersion: 1, draftId, answers};
}

/** Record consumed files separately from the draft's semantic revision. External inputs stay user-owned. */
export async function recordMigrationAnswers(draftFile: string, draftId: string, answersFile: string, bytes: Uint8Array): Promise<void> {
    const path = relative(dirname(resolve(draftFile)), resolve(answersFile)).split(sep).join("/");
    if (!isSafeArtifactPath(path) || resolve(answersFile) === resolve(draftFile) || resolve(answersFile) === resolve(inputsFile(draftFile))) return;
    const inputs = await readInputs(draftFile, draftId) ?? {formatVersion: 1 as const, draftId, answers: []};
    const file = {path, contentHash: sha256Hex(bytes), byteLength: bytes.length};
    inputs.answers = [...inputs.answers.filter(one => one.path !== path), file];
    await writeJsonAtomic(inputsFile(draftFile), inputs);
}

function references(value: unknown, names: Set<string>): void {
    if (Array.isArray(value)) {for (const one of value) references(one, names);}
    else if (isPlainObject(value)) {
        if (["sql", "check", "query"].includes(String(value.kind)) && typeof value.name === "string") names.add(value.name.toLowerCase());
        for (const one of Object.values(value)) references(one, names);
    }
}

async function sharedResources(root: string, draftFile: string): Promise<Set<string> | undefined> {
    const names = new Set<string>();
    async function visit(directory: string): Promise<void> {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            if (entry.isSymbolicLink()) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!["entries", "resources"].includes(entry.name)) await visit(path);
            } else if (entry.isFile() && entry.name.endsWith(".json") && resolve(path) !== resolve(draftFile)
                && !entry.name.endsWith(".states.json") && !entry.name.endsWith(".inputs.json")
                && !["catalog.json", "baseline.json"].includes(entry.name)) {
                const raw: unknown = JSON.parse(await readFile(path, "utf8"));
                if (isPlainObject(raw) && raw.formatVersion === 1 && isPlainObject(raw.base) && Array.isArray(raw.changes)) references(raw, names);
            }
        }
    }
    try {await visit(root); return names;}
    catch {return undefined;} // An unreadable or unfinished draft must not lose its resources.
}

async function removeMatching(root: string, path: string, expected: {contentHash: string; byteLength?: number}): Promise<boolean> {
    if (!inside(root, path)) return false;
    try {
        if (resolve(await realpath(path)) !== resolve(path) || !(await lstat(path)).isFile()) return false;
        const bytes = await readFile(path);
        if (sha256Hex(bytes) !== expected.contentHash || (expected.byteLength !== undefined && bytes.length !== expected.byteLength)) return false;
        await unlink(path);
        return true;
    } catch (error) {if (missing(error)) return false; throw error;}
}

async function removeEmptyParents(directory: string, root: string): Promise<void> {
    while (resolve(directory) === resolve(root) || inside(root, directory)) {
        try {
            if (resolve(await realpath(directory)) !== resolve(directory)) return;
            await rmdir(directory);
        } catch (error) {
            if (missing(error) || (error instanceof Error && "code" in error && ["ENOTEMPTY", "EEXIST"].includes(String(error.code)))) return;
            throw error;
        }
        directory = dirname(directory);
    }
}

/** Run only after the artifact and catalog are durable; never traverse symlinks or remove changed inputs. */
export async function cleanupMigrationInputs(root: string, draftFile: string, draft: MigrationDraftInfo, resources: readonly ResourceRefInfo[]): Promise<void> {
    if (!inside(root, draftFile) || inside(join(root, "entries"), draftFile) || inside(join(root, "resources"), draftFile)) return;
    const draftBytes = await readFile(draftFile);
    const current: unknown = JSON.parse(draftBytes.toString("utf8"));
    if (sha256Hex(jsonBytes(current)) !== sha256Hex(jsonBytes(draft))) return;
    const inputs = await readInputs(draftFile, draft.id);
    if (inputs !== undefined) {
        for (const file of inputs.answers) {
            const path = join(dirname(draftFile), file.path);
            const bytes = await readFile(path).catch(error => {if (missing(error)) return undefined; throw error;});
            if (bytes === undefined || bytes.length !== file.byteLength || sha256Hex(bytes) !== file.contentHash) continue;
            const raw: unknown = JSON.parse(bytes.toString("utf8"));
            if (!isPlainObject(raw) || raw.id !== draft.id || !Array.isArray(raw.decisions)
                || !raw.decisions.every(decision => draft.decisions.some(used => sha256Hex(jsonBytes(used)) === sha256Hex(jsonBytes(decision))))) continue;
            await removeMatching(root, path, file);
        }
    }
    const shared = await sharedResources(root, draftFile);
    const directory = join(root, "resources");
    if (shared !== undefined) for (const ref of resources) {
        if (!isSafeArtifactPath(ref.name) || shared.has(ref.name.toLowerCase())) continue;
        const path = join(directory, ref.name);
        if (await removeMatching(directory, path, ref)) await removeEmptyParents(dirname(path), directory);
    }
    if (inputs !== undefined) {
        const path = inputsFile(draftFile);
        await removeMatching(root, path, {contentHash: sha256Hex(await readFile(path))});
    }
}

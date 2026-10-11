import {strict as assert} from "node:assert";
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "mocha";
import type {FileInfo} from "system-definition";
import {openArtifactDirectory, publishArtifactDirectory, type ArtifactDirectory} from "../src/artifact-files";
import {sha256Hex, type ArtifactResult} from "../src/artifact";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type ReaderSignature = Expect<Equal<ArtifactDirectory["readVerified"], (file: FileInfo) => Promise<ArtifactResult<Uint8Array>>>>;
type PublisherSignature = Expect<Equal<typeof publishArtifactDirectory, (destination: string, files: ReadonlyMap<string, Uint8Array>) => Promise<void>>>;
const signatures: [ReaderSignature, PublisherSignature] = [true, true];

function value<T>(result: ArtifactResult<T>): T {
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.value;
}
const bytes = (text: string) => new TextEncoder().encode(text);
const ref = (path: string, content: Uint8Array): FileInfo => ({path, contentHash: sha256Hex(content), byteLength: content.length});

async function temporary(body: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "sd-artifact-files-"));
    try { await body(directory); }
    finally { await rm(directory, {recursive: true, force: true}); }
}

describe("shared artifact files", () => {
    it("publishes and reads exact bytes through the core FileInfo contract", () => temporary(async root => {
        assert.deepEqual(signatures, [true, true]);
        const content = bytes("SELECT 1;\r\n");
        const target = join(root, "release");
        await publishArtifactDirectory(target, new Map([["resources/create.sql", content]]));
        const directory = value(await openArtifactDirectory(target));
        assert.deepEqual([...value(await directory.readVerified(ref("resources/create.sql", content)))], [...content]);
        assert.deepEqual([...value(await directory.read("resources/create.sql"))], [...content]);
        // @ts-expect-error An unchecked path cannot replace a byte-addressed FileInfo.
        const invalid: Parameters<ArtifactDirectory["readVerified"]>[0] = "resources/create.sql";
        void invalid;
        // @ts-expect-error Publication requires bytes; serialization is the caller's explicit choice.
        const invalidFiles: Parameters<typeof publishArtifactDirectory>[1] = new Map([["data.json", {value: 1}]]);
        void invalidFiles;
    }));

    it("blocks both changed lengths and changed bytes", () => temporary(async root => {
        const content = bytes("SELECT 1;");
        const target = join(root, "release");
        await publishArtifactDirectory(target, new Map([["run.sql", content]]));
        const directory = value(await openArtifactDirectory(target));
        for (const modified of ["SELECT 2;", "SELECT 123;"]) {
            await writeFile(join(target, "run.sql"), modified);
            const result = await directory.readVerified(ref("run.sql", content));
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.problems[0]!.messageKey, "migration.checksumMismatch");
        }
    }));

    it("never replaces an existing publication", () => temporary(async root => {
        const target = join(root, "release");
        await publishArtifactDirectory(target, new Map([["identity", bytes("original")]]));
        await assert.rejects(publishArtifactDirectory(target, new Map([["identity", bytes("replacement")]])));
        assert.equal(await readFile(join(target, "identity"), "utf8"), "original");
        assert.deepEqual(await readdir(root), ["release"]);
    }));

    it("rejects escaping paths and case collisions without partial output", () => temporary(async root => {
        const target = join(root, "release");
        for (const path of ["../escape", "/absolute", "C:/absolute", "nested\\escape", "a//b", "a/./b"]) {
            await assert.rejects(publishArtifactDirectory(target, new Map([[path, bytes("bad")]])));
            assert.deepEqual(await readdir(root), []);
        }
        await assert.rejects(publishArtifactDirectory(target, new Map([["A.sql", bytes("one")], ["a.sql", bytes("two")]])));
        assert.deepEqual(await readdir(root), []);
    }));

    it("cleans owned temporary output after a write failure", () => temporary(async root => {
        await assert.rejects(publishArtifactDirectory(join(root, "release"), new Map([["parent", bytes("file")], ["parent/child", bytes("child")]])));
        assert.deepEqual(await readdir(root), []);
    }));

    it("rejects symlinked roots and files, even when a link stays inside the root", () => temporary(async root => {
        const target = join(root, "release");
        await publishArtifactDirectory(target, new Map([["original", bytes("content")]]));
        await symlink(target, join(root, "alias"), "dir");
        assert.equal((await openArtifactDirectory(join(root, "alias"))).ok, false);
        await symlink(join(target, "original"), join(target, "alias"), "file");
        const directory = value(await openArtifactDirectory(target));
        assert.equal((await directory.read("alias")).ok, false);
        assert.equal((await directory.read("../release/original")).ok, false);
    }));
});

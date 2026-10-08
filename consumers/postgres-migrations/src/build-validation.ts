import {build} from "esbuild";
import {createHash} from "node:crypto";
import type {SystemSnapshotInfo} from "system-definition";
import type {SnapshotSide} from "./migration-authoring";
import type {ValidationArtifactInfo} from "./validation-artifact";

/** Bundle the entry and its imports together so later source edits cannot alter historical checks. */
export async function buildValidationArtifact(
    entry: string, side: SnapshotSide, snapshot: SystemSnapshotInfo, snapshotHash: string,
): Promise<{info: ValidationArtifactInfo; bytes: Uint8Array}> {
    const result = await build({entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm", target: "node24", packages: "bundle"});
    if (result.outputFiles.length !== 1) throw new Error("Validation build must produce exactly one self-contained module");
    const bytes = result.outputFiles[0]!.contents;
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const info: ValidationArtifactInfo = {
        formatVersion: 1, side, snapshotHash,
        entry: {path: `validators/${contentHash}.mjs`, contentHash, byteLength: bytes.length},
        runtime: {nodeVersion: process.version, abi: "migration-validation-1"},
        domainContractHashes: Object.fromEntries(snapshot.typeNames.map(name => [name, contentHash])),
        entityValidatorNames: Object.fromEntries(Object.entries(snapshot.entities).map(([name, entity]) => [name, entity.validators])),
    };
    return {info, bytes};
}

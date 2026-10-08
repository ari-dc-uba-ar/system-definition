import {createHash} from "node:crypto";
import type {FileInfo, ValidationResult} from "system-definition";

export type AuthoredResource = {
    ref: {name: string; kind: "sql" | "check" | "query"; contentHash: string};
    text: string;
};

/** The compiler emits bytes through this boundary; the manifest keeps only immutable references. */
export class AuthoringFiles {
    readonly resources = new Map<string, AuthoredResource>();
    readonly files = new Map<string, Uint8Array>();

    async emitResource(resource: AuthoredResource): Promise<ValidationResult<FileInfo>> {
        const bytes = new TextEncoder().encode(resource.text);
        const contentHash = createHash("sha256").update(bytes).digest("hex");
        if (contentHash !== resource.ref.contentHash) throw new Error("Compiler resource hash mismatch");
        const file = {path: `generated/${contentHash}.sql`, contentHash, byteLength: bytes.length};
        this.resources.set(resource.ref.name, resource);
        this.files.set(file.path, bytes);
        return {ok: true, value: file};
    }
}

import {createHash} from "node:crypto";
import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ValidationResult} from "system-definition";
import {
    decodeValidationArtifact,
    loadValidationModule,
    validationArtifactEvidenceHash,
    type ValidationArtifactHost,
    type ValidationArtifactInfo,
    type ValidationModule,
} from "../src/validation-artifact";

const hash = (digit: string): string => digit.repeat(64);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function ok<T>(result: ValidationResult<T>): T {
    if (!result.ok) assert.fail(JSON.stringify(result.problems));
    return result.value;
}

function artifact(entryHash = hash("1")): ValidationArtifactInfo {
    return {
        formatVersion: 1,
        side: "from",
        snapshotHash: hash("2"),
        entry: {
            path: "validation.cjs",
            contentHash: entryHash,
            byteLength: 18,
        },
        runtime: {
            nodeVersion: "v24.9.0",
            abi: "migration-validation-1",
        },
        domainContractHashes: {
            text: hash("3"),
            integer: hash("4"),
        },
        entityValidatorNames: {
            people: ["validEmail", "adult"],
        },
    };
}

function moduleFor(info: ValidationArtifactInfo): ValidationModule {
    return {
        abi: "migration-validation-1",
        snapshotHash: info.snapshotHash,
        validatePorts: () => [],
        validateEntityRow: () => [],
    };
}

const _decodeSignature: (value: unknown) => ValidationResult<ValidationArtifactInfo> = decodeValidationArtifact;
const _hashSignature: (info: ValidationArtifactInfo) => string = validationArtifactEvidenceHash;
const _loadSignature: (
    info: ValidationArtifactInfo,
    host: ValidationArtifactHost,
) => Promise<ValidationResult<ValidationModule>> = loadValidationModule;
void _decodeSignature;
void _hashSignature;
void _loadSignature;

describe("historical validation artifacts", () => {
    it("decodes strict detached metadata and rejects malformed historical contracts", () => {
        const raw = artifact() as unknown as Record<string, unknown>;
        const decoded = ok<ValidationArtifactInfo>(decodeValidationArtifact(raw));
        assert.deepEqual(decoded.entityValidatorNames.people, ["validEmail", "adult"]);

        (raw.domainContractHashes as Record<string, string>).text = hash("9");
        assert.equal(decoded.domainContractHashes.text, hash("3"));

        const extra = {...artifact(), unexpected: true};
        assert.equal(decodeValidationArtifact(extra).ok, false);
        assert.equal(decodeValidationArtifact({...artifact(), formatVersion: 2}).ok, false);
        assert.equal(decodeValidationArtifact({...artifact(), runtime: {nodeVersion: "v24.9.0", abi: "other"}}).ok, false);
        assert.equal(decodeValidationArtifact({...artifact(), entry: {...artifact().entry, contentHash: "ABC"}}).ok, false);
    });

    it("binds verification evidence to module bytes and declared domain/validator contracts", () => {
        const first = artifact();
        assert.equal(validationArtifactEvidenceHash(first), validationArtifactEvidenceHash(artifact()));
        assert.notEqual(
            validationArtifactEvidenceHash(first),
            validationArtifactEvidenceHash({...first, entry: {...first.entry, contentHash: hash("5")}}),
        );
        assert.notEqual(
            validationArtifactEvidenceHash(first),
            validationArtifactEvidenceHash({...first, domainContractHashes: {...first.domainContractHashes, text: hash("6")}}),
        );
        assert.notEqual(
            validationArtifactEvidenceHash(first),
            validationArtifactEvidenceHash({...first, entityValidatorNames: {people: ["validEmail"]}}),
        );
    });

    it("verifies exact bytes before loading and uses the content hash as the module cache identity", async () => {
        const bytes = Buffer.from("module.exports = 1", "utf8");
        const info = artifact(sha256(bytes));
        const calls: string[] = [];
        const host: ValidationArtifactHost = {
            nodeVersion: "v24.9.0",
            readEntry: async () => {
                calls.push("read");
                return bytes;
            },
            importModule: async (_entry: {path: string; contentHash: string; byteLength: number}, cacheIdentity: string) => {
                calls.push("import:" + cacheIdentity);
                return moduleFor(info);
            },
        };

        const loaded = ok<ValidationModule>(await loadValidationModule(info, host));
        assert.equal(loaded.snapshotHash, info.snapshotHash);
        assert.deepEqual(calls, ["read", "import:" + info.entry.contentHash]);

        let imported = false;
        const tampered: ValidationArtifactHost = {
            ...host,
            readEntry: async () => Buffer.from("different bytes", "utf8"),
            importModule: async () => {
                imported = true;
                return moduleFor(info);
            },
        };
        assert.equal((await loadValidationModule(info, tampered)).ok, false);
        assert.equal(imported, false, "tampered bytes must be rejected before module evaluation");
    });

    it("rejects the wrong Node runtime, ABI, snapshot or module shape", async () => {
        const bytes = Buffer.from("module.exports = 1", "utf8");
        const info = artifact(sha256(bytes));
        const hostFor = (value: unknown, nodeVersion = "v24.9.0"): ValidationArtifactHost => ({
            nodeVersion,
            readEntry: async () => bytes,
            importModule: async () => value,
        });

        assert.equal((await loadValidationModule(info, hostFor(moduleFor(info), "v24.10.0"))).ok, false);
        assert.equal((await loadValidationModule(info, hostFor({...moduleFor(info), abi: "other"}))).ok, false);
        assert.equal((await loadValidationModule(info, hostFor({...moduleFor(info), snapshotHash: hash("8")}))).ok, false);
        assert.equal((await loadValidationModule(info, hostFor({
            abi: "migration-validation-1",
            snapshotHash: info.snapshotHash,
            validatePorts: () => [],
        }))).ok, false);
    });
});

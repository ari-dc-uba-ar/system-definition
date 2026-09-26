import {
    computeReleaseHash,
    loadReleaseArtifact,
    publishReleaseArtifact,
    sha256Hex,
    type EnvironmentInfo,
    type ManagedDataInfo,
    type ReleaseArtifact,
    type ReleaseArtifactDraft,
    type ReleaseManifestInfo,
} from "../src/artifact";

const _sha256: (bytes: Uint8Array) => string = sha256Hex;
const _releaseHash: (manifest: ReleaseManifestInfo) => string = computeReleaseHash;
const _publish: (root: string, draft: ReleaseArtifactDraft) => Promise<unknown> = publishReleaseArtifact;
const _load: (path: string) => Promise<unknown> = loadReleaseArtifact;

const environment: EnvironmentInfo = {
    engine: "postgresql",
    version: "18.6",
    serverVersionNum: 180006,
    encoding: "UTF8",
    collations: {},
    externalDependencies: {},
};

const managedData: ManagedDataInfo = {
    table: {schema: "app", name: "settings"},
    key: ["name"],
    columns: ["name", "value"],
    rows: [{name: "mode", value: "strict"}],
};

function acceptsArtifact(_artifact: ReleaseArtifact): void {}
void acceptsArtifact;
void environment;
void managedData;
void _sha256;
void _releaseHash;
void _publish;
void _load;

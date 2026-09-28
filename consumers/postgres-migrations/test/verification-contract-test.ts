import type {
    MigrationPathInfo,
    PersistenceInfo,
    PublishedMigrationInfo,
    ReleaseRefInfo,
    SystemSnapshotInfo,
    ValidationResult,
} from "system-definition";
import type {MigrationExecutionContext} from "../src/execute-migration";
import type {InstallationScope, JournalConfig} from "../src/journal";
import type {InspectionScope} from "../src/inspect-schema";
import type {PgSchemaInfo, PgSession, StorageContext} from "../src/pg-schema";
import {verifyRelease, verifyUpgrade} from "../src/verify";
import {
    A,
    B,
    aidaEmailInspection,
    aidaEmailJournal,
    aidaEmailPath,
    aidaEmailPersistence,
    aidaEmailScope,
    aidaEmailSnapshotA,
    aidaEmailSnapshotB,
    aidaEmailStorage,
    executionContext,
    loadAidaEmailFixture,
    verifyAidaEmailFixture,
} from "../fixtures/aida-email";

type ExpectedScratchHandle = {id: string; session: PgSession};
type ExpectedScratchProvider = {
    create(purpose: "clean-target" | "upgrade-source"): Promise<ValidationResult<ExpectedScratchHandle>>;
    owns(handle: ExpectedScratchHandle): boolean;
    destroy(handle: ExpectedScratchHandle): Promise<ValidationResult<true>>;
};
type ExpectedReleaseVerificationInput = {
    ref: ReleaseRefInfo;
    snapshot: SystemSnapshotInfo;
    persistence: PersistenceInfo;
    storage: StorageContext;
    inspection: InspectionScope;
};
type ExpectedUpgradeVerificationInput = {
    source: ExpectedReleaseVerificationInput;
    target: ExpectedReleaseVerificationInput;
    path: MigrationPathInfo;
    journal: JournalConfig;
    scope: InstallationScope;
    fixture: {
        id: string;
        load(session: PgSession): Promise<ValidationResult<true>>;
        verify(session: PgSession): Promise<ValidationResult<true>>;
    };
    resolveContext(migration: PublishedMigrationInfo): MigrationExecutionContext;
};
type ExpectedUpgradeVerificationInfo = {
    cleanTarget: PgSchemaInfo;
    upgradedTarget: PgSchemaInfo;
    fixtureId: string;
};
type ExpectedVerifyRelease = (
    release: ExpectedReleaseVerificationInput,
    scratch: ExpectedScratchProvider,
) => Promise<ValidationResult<PgSchemaInfo>>;
type ExpectedVerifyUpgrade = (
    input: ExpectedUpgradeVerificationInput,
    scratch: ExpectedScratchProvider,
) => Promise<ValidationResult<ExpectedUpgradeVerificationInfo>>;

// These assignments become the public contract once ../src/verify exists; while it is the
// intentional red, the unresolved import does not create secondary type-test diagnostics.
const releaseSignature: ExpectedVerifyRelease = verifyRelease;
const upgradeSignature: ExpectedVerifyUpgrade = verifyUpgrade;
void releaseSignature;
void upgradeSignature;

const session = null as unknown as PgSession;
const scratch: ExpectedScratchHandle = {id: "scratch-1", session};
const provider: ExpectedScratchProvider = {
    async create(_purpose: "clean-target" | "upgrade-source") { return {ok: true, value: scratch}; },
    owns(handle: ExpectedScratchHandle) { return handle === scratch; },
    async destroy(_handle: ExpectedScratchHandle) { return {ok: true, value: true}; },
};

const releaseA: ExpectedReleaseVerificationInput = {
    ref: A,
    snapshot: aidaEmailSnapshotA,
    persistence: aidaEmailPersistence,
    storage: aidaEmailStorage,
    inspection: aidaEmailInspection,
};
const releaseB: ExpectedReleaseVerificationInput = {
    ref: B,
    snapshot: aidaEmailSnapshotB,
    persistence: aidaEmailPersistence,
    storage: aidaEmailStorage,
    inspection: aidaEmailInspection,
};

const upgradeInput: ExpectedUpgradeVerificationInput = {
    source: releaseA,
    target: releaseB,
    path: aidaEmailPath,
    journal: aidaEmailJournal,
    scope: aidaEmailScope,
    fixture: {id: "aida-email", load: loadAidaEmailFixture, verify: verifyAidaEmailFixture},
    resolveContext: executionContext,
};
void provider;
void upgradeInput;

// The expected T13 contract has no forgeable isScratch boolean and no target-side bypass flag.
type ScratchKeys = keyof ExpectedScratchHandle;
const noScratchFlag: Exclude<ScratchKeys, "isScratch"> = "id";
void noScratchFlag;
type UpgradeKeys = keyof ExpectedUpgradeVerificationInput;
const noSkipVerification: Exclude<UpgradeKeys, "skipVerification"> = "path";
void noSkipVerification;

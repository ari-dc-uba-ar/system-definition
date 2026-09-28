import type {
    MigrationPathInfo,
    Problem,
    PublishedMigrationInfo,
    ReleaseRefInfo,
    ValidationResult,
} from "system-definition";
import type {MigrationExecutionContext} from "../src/execute-migration";
import type {InstallationScope, JournalConfig} from "../src/journal";
import type {PgSession} from "../src/pg-schema";
import {checkRehearsalRequirement, rehearseUpgrade} from "../src/rehearsal";

type ExpectedRehearsalCopyRef = {
    copyId: string;
    provenance: string;
    installationId: string;
    source: ReleaseRefInfo;
    schemas: readonly string[];
};
type ExpectedRehearsalHandle = {copy: ExpectedRehearsalCopyRef; session: PgSession};
type ExpectedRehearsalProvider = {
    open(copy: ExpectedRehearsalCopyRef): Promise<ValidationResult<ExpectedRehearsalHandle>>;
    owns(handle: ExpectedRehearsalHandle): boolean;
    destroy(handle: ExpectedRehearsalHandle): Promise<ValidationResult<true>>;
};
type ExpectedRehearsalArtifactInfo = {
    kind: "release" | "migration" | "resource";
    id: string;
    contentHash: string;
};
type ExpectedRehearsalCheckInfo = {id: string; contentHash: string};
type ExpectedRehearsalReportInfo = {
    copy: ExpectedRehearsalCopyRef;
    from: ReleaseRefInfo;
    to: ReleaseRefInfo;
    scope: InstallationScope;
    migrations: readonly {id: string; migrationHash: string}[];
    artifacts: readonly ExpectedRehearsalArtifactInfo[];
    checks: readonly ExpectedRehearsalCheckInfo[];
    targetChecksRequired: true;
};
type ExpectedRehearsalInput = {
    copy: ExpectedRehearsalCopyRef;
    path: MigrationPathInfo;
    journal: JournalConfig;
    scope: InstallationScope;
    resolveContext(migration: PublishedMigrationInfo):
        | MigrationExecutionContext
        | ValidationResult<MigrationExecutionContext>
        | Promise<MigrationExecutionContext | ValidationResult<MigrationExecutionContext>>;
};
type ExpectedRehearsalRequirement = {
    production: boolean;
    operation: "install" | "upgrade";
    from: ReleaseRefInfo | null;
    to: ReleaseRefInfo;
    scope: InstallationScope;
    path: MigrationPathInfo | null;
};
type ExpectedRehearseUpgrade = (
    input: ExpectedRehearsalInput,
    provider: ExpectedRehearsalProvider,
) => Promise<ValidationResult<ExpectedRehearsalReportInfo>>;
type ExpectedCheckRequirement = (
    requirement: ExpectedRehearsalRequirement,
    rehearsal: ValidationResult<ExpectedRehearsalReportInfo> | null,
) => ValidationResult<ExpectedRehearsalReportInfo | null>;

const rehearseSignature: ExpectedRehearseUpgrade = rehearseUpgrade;
const requirementSignature: ExpectedCheckRequirement = checkRehearsalRequirement;
void rehearseSignature;
void requirementSignature;

const release: ReleaseRefInfo = {systemId: "sys", releaseId: "A", releaseHash: "a".repeat(64)};
const copy: ExpectedRehearsalCopyRef = {
    copyId: "copy-1",
    provenance: "backup:prod-20260928T120000Z",
    installationId: "installation-1",
    source: release,
    schemas: ["app"],
};
const session = null as unknown as PgSession;
const handle: ExpectedRehearsalHandle = {copy, session};
const provider: ExpectedRehearsalProvider = {
    async open(_copy: ExpectedRehearsalCopyRef) { return {ok: true, value: handle}; },
    owns(one: ExpectedRehearsalHandle) { return one === handle; },
    async destroy(_handle: ExpectedRehearsalHandle) { return {ok: true, value: true}; },
};
void provider;

// A rehearsal is evidence about a copy. It is deliberately not deployment readiness and
// explicitly says that target-side checks still have to run under maintenance.
type ReportKeys = keyof ExpectedRehearsalReportInfo;
const noReadyFlag: Exclude<ReportKeys, "ready" | "allowed" | "skipTargetChecks"> = "targetChecksRequired";
void noReadyFlag;
const problems: readonly Problem[] = [];
void problems;

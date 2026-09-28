import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
import type {JournalConfig} from "../src/journal";
import type {PgSession} from "../src/pg-schema";
import {
    checkApplyEligibility,
    deriveVerificationStatus,
    readLatestVerification,
    recordVerification,
    type DeploymentBindingInfo,
    type EvidenceContext,
    type VerificationCheckInfo,
    type VerificationRunDraft,
    type VerificationRunInfo,
} from "../src/evidence";

type ExpectedDeploymentBindingBase = {
    deploymentId: string;
    installationId: string;
    candidateApplicationHash: string;
    planHash: string;
    to: ReleaseRefInfo;
    engineVersion: "18.6";
    schemas: readonly string[];
    configurationHash: string;
    maintenanceId: string;
    production: boolean;
};
type ExpectedDeploymentBindingInfo = ExpectedDeploymentBindingBase & (
    | {operation: "install"; from: null}
    | {operation: "upgrade"; from: ReleaseRefInfo}
);
type ExpectedVerificationCheckInfo = {
    id: string;
    kind: "artifacts" | "environment" | "structure" | "data" | "rehearsal";
    status: "passed" | "failed" | "incomplete";
    reportId: string;
    problems: readonly Problem[];
};
type ExpectedVerificationRunInfo = {
    verificationId: string;
    ordinal: number;
    binding: ExpectedDeploymentBindingInfo;
    status: "passed" | "failed" | "incomplete";
    checks: readonly ExpectedVerificationCheckInfo[];
    createdAt: string;
};
type ExpectedVerificationRunDraft = Omit<ExpectedVerificationRunInfo, "ordinal" | "status">;
type ExpectedEvidenceContext = {session: PgSession; journal: JournalConfig};

type ExpectedDerive = (
    binding: ExpectedDeploymentBindingInfo,
    checks: readonly ExpectedVerificationCheckInfo[],
) => ExpectedVerificationRunInfo["status"];
type ExpectedRecord = (
    session: PgSession,
    journal: JournalConfig,
    run: ExpectedVerificationRunDraft,
) => Promise<ValidationResult<ExpectedVerificationRunInfo>>;
type ExpectedReadLatest = (
    session: PgSession,
    journal: JournalConfig,
    deploymentId: string,
) => Promise<ValidationResult<ExpectedVerificationRunInfo | null>>;
type ExpectedEligibility = (
    binding: ExpectedDeploymentBindingInfo,
    context: ExpectedEvidenceContext,
) => Promise<ValidationResult<ExpectedVerificationRunInfo>>;

const deriveSignature: ExpectedDerive = deriveVerificationStatus;
const recordSignature: ExpectedRecord = recordVerification;
const readSignature: ExpectedReadLatest = readLatestVerification;
const eligibilitySignature: ExpectedEligibility = checkApplyEligibility;
void deriveSignature;
void recordSignature;
void readSignature;
void eligibilitySignature;

const A: ReleaseRefInfo = {systemId: "aida", releaseId: "A", releaseHash: "a".repeat(64)};
const B: ReleaseRefInfo = {systemId: "aida", releaseId: "B", releaseHash: "b".repeat(64)};
const installExpected: ExpectedDeploymentBindingInfo = {
    deploymentId: "deployment-install",
    installationId: "installation-1",
    candidateApplicationHash: "c".repeat(64),
    planHash: "d".repeat(64),
    operation: "install",
    from: null,
    to: B,
    engineVersion: "18.6",
    schemas: ["app"],
    configurationHash: "e".repeat(64),
    maintenanceId: "maintenance-1",
    production: true,
};
const upgradeExpected: ExpectedDeploymentBindingInfo = {...installExpected, operation: "upgrade", from: A};
const installActual: DeploymentBindingInfo = installExpected;
const upgradeActual: DeploymentBindingInfo = upgradeExpected;
const installBack: ExpectedDeploymentBindingInfo = installActual;
const upgradeBack: ExpectedDeploymentBindingInfo = upgradeActual;
void installBack;
void upgradeBack;

const checkExpected: ExpectedVerificationCheckInfo = {
    id: "artifacts",
    kind: "artifacts",
    status: "passed",
    reportId: "report-artifacts",
    problems: [],
};
const checkActual: VerificationCheckInfo = checkExpected;
const checkBack: ExpectedVerificationCheckInfo = checkActual;
void checkBack;

const draftExpected: ExpectedVerificationRunDraft = {
    verificationId: "verification-1",
    binding: installExpected,
    checks: [checkExpected],
    createdAt: "2026-09-28T12:00:00.000Z",
};
const draftActual: VerificationRunDraft = draftExpected;
const draftBack: ExpectedVerificationRunDraft = draftActual;
void draftBack;

const runExpected: ExpectedVerificationRunInfo = {...draftExpected, ordinal: 1, status: "incomplete"};
const runActual: VerificationRunInfo = runExpected;
const runBack: ExpectedVerificationRunInfo = runActual;
void runBack;

const contextExpected: ExpectedEvidenceContext = {
    session: null as unknown as PgSession,
    journal: {schema: "sd_journal"},
};
const contextActual: EvidenceContext = contextExpected;
const contextBack: ExpectedEvidenceContext = contextActual;
void contextBack;

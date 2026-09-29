import type {Problem, ReleaseRefInfo, ValidationResult} from "system-definition";
import type {DeploymentBindingInfo} from "../src/evidence";
import type {JournalConfig} from "../src/journal";
import type {PgSession} from "../src/pg-schema";
import {
    checkDeploymentReady,
    runDeploymentPipeline,
    type DeploymentGateRuntime,
    type DeploymentPipelineRuntime,
    type DeploymentReadinessInfo,
    type DeploymentReadyInfo,
} from "../src/deployment-gate";

type ExpectedReadinessInfo = {
    binding: DeploymentBindingInfo;
    state: "pending" | "blocked" | "ready" | "consumed";
    verificationId: string | null;
    applyAttemptId: string | null;
    confirmedTarget: ReleaseRefInfo | null;
    problems: readonly Problem[];
};

type ExpectedReadyInfo = {
    binding: DeploymentBindingInfo;
    verificationId: string;
    applyAttemptId: string;
    confirmedTarget: ReleaseRefInfo;
};

type ExpectedGateRuntime = {
    session: PgSession;
    journal: JournalConfig;
    maintenance: {
        isActive(maintenanceId: string, installationId: string): Promise<boolean>;
    };
    finalChecks(
        session: PgSession,
        binding: DeploymentBindingInfo,
    ): Promise<ValidationResult<true>>;
};

type ExpectedPipelineRuntime = ExpectedGateRuntime & {
    exclusivity: {
        runExclusive<T>(
            deploymentId: string,
            installationId: string,
            work: () => Promise<ValidationResult<T>>,
        ): Promise<ValidationResult<T>>;
    };
    apply(binding: DeploymentBindingInfo): Promise<ValidationResult<true>>;
    activate(candidateApplicationHash: string): Promise<ValidationResult<true>>;
    completeMaintenance(maintenanceId: string): Promise<ValidationResult<true>>;
};

type ExpectedCheckReady = (
    binding: DeploymentBindingInfo,
    runtime: ExpectedGateRuntime,
) => Promise<ValidationResult<ExpectedReadyInfo>>;

type ExpectedRunPipeline = (
    binding: DeploymentBindingInfo,
    runtime: ExpectedPipelineRuntime,
) => Promise<ValidationResult<ExpectedReadyInfo>>;

const checkSignature: ExpectedCheckReady = checkDeploymentReady;
const pipelineSignature: ExpectedRunPipeline = runDeploymentPipeline;
void checkSignature;
void pipelineSignature;

const readinessExpected = null as unknown as ExpectedReadinessInfo;
const readinessActual: DeploymentReadinessInfo = readinessExpected;
const readinessBack: ExpectedReadinessInfo = readinessActual;
void readinessBack;

const readyExpected = null as unknown as ExpectedReadyInfo;
const readyActual: DeploymentReadyInfo = readyExpected;
const readyBack: ExpectedReadyInfo = readyActual;
void readyBack;

const gateExpected = null as unknown as ExpectedGateRuntime;
const gateActual: DeploymentGateRuntime = gateExpected;
const gateBack: ExpectedGateRuntime = gateActual;
void gateBack;

const pipelineExpected = null as unknown as ExpectedPipelineRuntime;
const pipelineActual: DeploymentPipelineRuntime = pipelineExpected;
const pipelineBack: ExpectedPipelineRuntime = pipelineActual;
void pipelineBack;

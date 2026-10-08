import type {DeploymentReadinessInfo} from "../src/deployment-gate";
import type {VerificationRunInfo} from "../src/evidence";
import {
    DEPLOYMENT_READINESS_STATES,
    VERIFICATION_STATUSES,
    type DeploymentReadinessState,
    type VerificationStatus,
} from "../src/journal-contracts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;
type Assert<T extends true> = T;

type _VerificationStatus = Assert<Equal<VerificationRunInfo["status"], VerificationStatus>>;
type _ReadinessState = Assert<Equal<DeploymentReadinessInfo["state"], DeploymentReadinessState>>;

const verificationValues: readonly VerificationStatus[] = VERIFICATION_STATUSES;
const readinessValues: readonly DeploymentReadinessState[] = DEPLOYMENT_READINESS_STATES;
void verificationValues;
void readinessValues;

// @ts-expect-error journal verification state vocabulary does not contain readiness values
const invalidVerification: VerificationStatus = "ready";
void invalidVerification;

// @ts-expect-error deployment readiness is distinct from verification status
const invalidReadiness: DeploymentReadinessState = "passed";
void invalidReadiness;

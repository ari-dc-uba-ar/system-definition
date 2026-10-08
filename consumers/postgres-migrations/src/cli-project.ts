import type {captureSystemSnapshot, ValidationResult} from "system-definition";
import type {AuthoringRuntime, MigrationDraftInfo} from "./authoring-contract";
import type {AuthoringFiles} from "./authoring-files";
import type {AuthoringContext} from "./migration-authoring";
import type {publishReleaseArtifact} from "./artifact";
import type {buildMigrationPlan} from "./migration-plan";
import type {ResolutionRuntime} from "./resolve-conflict";
import type {applyResolution, verifyResolution} from "./preparation";
import type {ReleaseVerificationInput, ScratchProvider, UpgradeVerificationInput} from "./verify";
import type {DeploymentBindingInfo, VerificationCheckInfo} from "./evidence";
import type {DeploymentGateRuntime} from "./deployment-gate";
import type {InstallationScope, PgSessionFactory} from "./journal";
import type {executeMigrationPath} from "./runner";

/** Application composition supplies context and I/O ports; the CLI owns command dispatch.
 * Export createMigrationProject() from a JS/compiled TS module. Only commands using a
 * particular port require it. close() releases application-owned connections in finally.
 */
export interface MigrationProject {
    authoring?: {
        draft: MigrationDraftInfo;
        runtime: AuthoringRuntime;
        files: AuthoringFiles;
        context: AuthoringContext;
    };
    capture?: Parameters<typeof captureSystemSnapshot>;
    release?: {input: ReleaseVerificationInput; scratch: ScratchProvider};
    publish?: Parameters<typeof publishReleaseArtifact>;
    plan?: Parameters<typeof buildMigrationPlan>;
    resolution?: ResolutionRuntime;
    verifyResolution?: Parameters<typeof verifyResolution>;
    applyResolution?: Parameters<typeof applyResolution>;
    deployment?: {
        binding: DeploymentBindingInfo;
        runtime: DeploymentGateRuntime;
        sessions: PgSessionFactory;
        scope: InstallationScope;
        lockWaitTimeoutMs: number;
        path: Parameters<typeof executeMigrationPath>[1];
        resolveContext: Parameters<typeof executeMigrationPath>[2];
        verification?: {
            input: UpgradeVerificationInput;
            scratch: ScratchProvider;
            /** Environment/artifact/rehearsal checks belong to application adapters.
             * Missing checks remain incomplete; a scratch fixture is not production rehearsal. */
            checks(): Promise<readonly VerificationCheckInfo[]>;
        };
    };
    close?(): Promise<void>;
}

export type MigrationProjectFactory = () => MigrationProject | Promise<MigrationProject>;
export type CommandResult = ValidationResult<unknown>;

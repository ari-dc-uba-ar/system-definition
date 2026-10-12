import type {ValidationResult} from "system-definition";

export const CLI_COMMANDS = ["capture", "assess", "infer", "generate", "data", "resolve", "status", "apply"] as const;
export type CliCommand = typeof CLI_COMMANDS[number];

export type CliExitCode = 0 | 2 | 3 | 4;

export type CliCommandExecutor = (
    command: CliCommand,
    args: readonly string[],
) => Promise<ValidationResult<unknown>>;

export type CliExecutionInfo = {
    exitCode: CliExitCode;
    result: ValidationResult<unknown>;
};

const inputOrConfigurationProblems = new Set([
    "migration.invalidJson",
    "migration.unsupportedFormat",
    "migration.invalidReference",
    "migration.invalidResourceKind",
    "migration.invalidCatalog",
    "migration.downgradeUnsupported",
    "migration.environmentMismatch",
    "migration.invalidExecutionOptions",
    "migration.unsupportedSql",
]);

const verificationOrGateProblems = new Set([
    "migration.checksumMismatch",
    "migration.schemaDrift",
    "migration.unsupportedSchemaFeature",
    "migration.checkFailed",
    "migration.headMismatch",
    "migration.permissionsInvalid",
]);

function problemExitCode(messageKey: string): Exclude<CliExitCode, 0> {
    if (inputOrConfigurationProblems.has(messageKey)) {
        return 2;
    }
    if (verificationOrGateProblems.has(messageKey)) {
        return 3;
    }
    return 4;
}

export function cliExitCode(result: ValidationResult<unknown>): CliExitCode {
    if (result.ok) {
        return 0;
    }
    let exitCode: Exclude<CliExitCode, 0> = 2;
    for (const one of result.problems) {
        const oneExitCode = problemExitCode(one.messageKey);
        if (oneExitCode === 4) {
            return 4;
        }
        if (oneExitCode === 3) {
            exitCode = 3;
        }
    }
    return exitCode;
}

export async function runCliCommand(
    command: CliCommand,
    args: readonly string[],
    execute: CliCommandExecutor,
): Promise<CliExecutionInfo> {
    const result = await execute(command, args);
    return {
        exitCode: cliExitCode(result),
        result,
    };
}

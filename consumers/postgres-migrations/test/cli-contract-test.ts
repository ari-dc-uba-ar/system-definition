import type {ValidationResult} from "system-definition";
import {
    cliExitCode,
    runCliCommand,
    type CliCommand,
    type CliCommandExecutor,
    type CliExecutionInfo,
    type CliExitCode,
} from "../src/cli";

type ExpectedCommand =
    | "capture"
    | "build-release"
    | "verify"
    | "publish"
    | "plan"
    | "status"
    | "install"
    | "apply"
    | "deployment-gate";

type ExpectedExitCode = 0 | 2 | 3 | 4;

type ExpectedExecutor = (
    command: ExpectedCommand,
    args: readonly string[],
) => Promise<ValidationResult<unknown>>;

type ExpectedExecutionInfo = {
    exitCode: ExpectedExitCode;
    result: ValidationResult<unknown>;
};

type ExpectedRunCliCommand = (
    command: ExpectedCommand,
    args: readonly string[],
    execute: ExpectedExecutor,
) => Promise<ExpectedExecutionInfo>;

type ExpectedCliExitCode = (result: ValidationResult<unknown>) => ExpectedExitCode;

const commandExpected = null as unknown as ExpectedCommand;
const commandActual: CliCommand = commandExpected;
const commandBack: ExpectedCommand = commandActual;
void commandBack;

const exitExpected = null as unknown as ExpectedExitCode;
const exitActual: CliExitCode = exitExpected;
const exitBack: ExpectedExitCode = exitActual;
void exitBack;

const executorExpected = null as unknown as ExpectedExecutor;
const executorActual: CliCommandExecutor = executorExpected;
const executorBack: ExpectedExecutor = executorActual;
void executorBack;

const executionExpected = null as unknown as ExpectedExecutionInfo;
const executionActual: CliExecutionInfo = executionExpected;
const executionBack: ExpectedExecutionInfo = executionActual;
void executionBack;

const runSignature: ExpectedRunCliCommand = runCliCommand;
const exitSignature: ExpectedCliExitCode = cliExitCode;
void runSignature;
void exitSignature;

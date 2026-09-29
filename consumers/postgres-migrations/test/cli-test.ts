import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {problem, type ValidationResult} from "system-definition";
import {
    cliExitCode,
    runCliCommand,
    type CliCommand,
    type CliCommandExecutor,
} from "../src/cli";

function failed(messageKey: string): ValidationResult<unknown> {
    return {
        ok: false,
        problems: [problem(null, messageKey, "blocking")],
    };
}

describe("migration CLI boundary", () => {
    it("maps complete success and the documented technical failure classes to 0/2/3/4", () => {
        assert.equal(cliExitCode({ok: true, value: {id: "ok"}}), 0);
        assert.equal(cliExitCode(failed("migration.invalidReference")), 2);
        assert.equal(cliExitCode(failed("migration.environmentMismatch")), 2);
        assert.equal(cliExitCode(failed("deployment.blocked")), 3);
        assert.equal(cliExitCode(failed("migration.unknownCommitOutcome")), 4);
    });

    it("delegates a command exactly once and returns the same library result", async () => {
        const calls: {command: CliCommand; args: readonly string[]}[] = [];
        const libraryResult = failed("deployment.verificationFailed");
        const execute: CliCommandExecutor = async (
            command: CliCommand,
            args: readonly string[],
        ) => {
            calls.push({command, args});
            return libraryResult;
        };

        const execution = await runCliCommand(
            "apply",
            ["--deployment", "deployment-17"],
            execute,
        );

        assert.deepEqual(calls, [{
            command: "apply",
            args: ["--deployment", "deployment-17"],
        }]);
        assert.equal(execution.result, libraryResult);
        assert.equal(execution.exitCode, 3);
    });
});

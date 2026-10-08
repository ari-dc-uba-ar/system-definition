import {strict as assert} from "node:assert";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
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
    it("ships a runnable postgres-migrations command with offline help", () => {
        const root = resolve(__dirname, "../..");
        const manifest: {bin?: Record<string, string>} = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
        const entry = manifest.bin?.["postgres-migrations"];
        assert.equal(typeof entry, "string", "the documented CLI must be registered in package.json");
        if (entry === undefined) return;
        const help = spawnSync(process.execPath, [resolve(root, entry), "--help"], {
            encoding: "utf8",
            timeout: 10_000,
            env: {...process.env, CI: "true", DATABASE_URL: ""},
        });
        assert.equal(help.error, undefined);
        assert.equal(help.status, 0, help.stderr);
        for (const command of ["infer", "add-data", "resolve", "verify", "apply"]) {
            assert.ok(help.stdout.includes(command), `help must document ${command}`);
        }
    });

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

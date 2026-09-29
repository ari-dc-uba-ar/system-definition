import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cliExitCode, type CliCommand, type CliExitCode } from "../src/cli";
import type { ValidationResult } from "system-definition";

const consumerRoot = resolve(__dirname, "../..");
const repositoryRoot = resolve(consumerRoot, "../..");

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

interface PackageJson {
    scripts?: Record<string, string>;
}

interface TsConfig {
    include?: string[];
}

interface CliDocExample {
    title: string;
    command: CliCommand;
    args: string[];
    result: ValidationResult<unknown>;
    exitCode: CliExitCode;
}

describe("T17 build, CI and generated documentation contract", () => {
    it("keeps the consumer outside root compile globs and exposes the required integration script", () => {
        const rootTsConfig = readJson(resolve(repositoryRoot, "tsconfig.json")) as TsConfig;
        assert.ok(
            (rootTsConfig.include ?? []).every((pattern) => !pattern.startsWith("consumers/")),
            "the root compiler must not absorb the postgres-migrations consumer",
        );

        const packageJson = readJson(resolve(consumerRoot, "package.json")) as PackageJson;
        assert.equal(typeof packageJson.scripts?.build, "string");
        assert.equal(typeof packageJson.scripts?.test, "string");
        assert.equal(
            typeof packageJson.scripts?.["test-integration"],
            "string",
            "T17 requires an explicit consumer integration command",
        );
    });

    it("defines pure Windows/Linux CI and a real PostgreSQL 18.6 integration job", () => {
        const workflowPath = resolve(repositoryRoot, ".github/workflows/postgres-migrations.yml");
        assert.ok(existsSync(workflowPath), "T17 requires a consumer CI workflow");
        const workflow = readFileSync(workflowPath, "utf8");

        assert.match(workflow, /ubuntu-latest/);
        assert.match(workflow, /windows-latest/);
        assert.match(workflow, /postgres:18\.6/);
        assert.match(workflow, /npm --prefix consumers\/postgres-migrations run test-integration/);
        assert.match(workflow, /npm --prefix consumers\/postgres-migrations run docs:check/);
        assert.doesNotMatch(workflow, /continue-on-error:\s*true/);

        const compose = readFileSync(resolve(repositoryRoot, "compose.yaml"), "utf8");
        assert.match(compose, /PGHOST:\s*postgres/);
        assert.match(compose, /depends_on:[\s\S]*postgres:[\s\S]*condition:\s*service_healthy/);
    });

    it("generates the consumer README from CLI examples that are themselves exercised by tests", () => {
        const fixturePath = resolve(consumerRoot, "test/fixtures/cli-doc-examples.json");
        const examples = readJson(fixturePath) as CliDocExample[];
        assert.ok(examples.length > 0);
        for (const example of examples) {
            assert.equal(cliExitCode(example.result), example.exitCode, example.title);
        }

        const packageJson = readJson(resolve(consumerRoot, "package.json")) as PackageJson;
        assert.equal(packageJson.scripts?.["docs:generate"], "node scripts/generate-readme.js");
        assert.equal(packageJson.scripts?.["docs:check"], "node scripts/generate-readme.js --check");

        const generatorPath = resolve(consumerRoot, "scripts/generate-readme.js");
        assert.ok(existsSync(generatorPath), "the README must have a generator, not a manual edit path");
        const generator = readFileSync(generatorPath, "utf8");
        assert.match(generator, /cli-doc-examples\.json/);

        const check = spawnSync(process.execPath, [generatorPath, "--check"], {
            cwd: consumerRoot,
            encoding: "utf8",
        });
        assert.equal(check.status, 0, check.stderr || check.stdout);

        const readme = readFileSync(resolve(consumerRoot, "README.md"), "utf8");
        assert.match(readme, /GENERATED.*generate-readme/i);
        const leeme = readFileSync(resolve(repositoryRoot, "LEEME.md"), "utf8");
        assert.match(leeme, /consumers\/postgres-migrations\/README\.md/);
    });
});

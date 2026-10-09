"use strict";
const assert = require("node:assert/strict");
const {mkdtemp, writeFile, readFile, rm} = require("node:fs/promises");
const {tmpdir} = require("node:os");
const {resolve, join} = require("node:path");
const {spawnSync} = require("node:child_process");
const {computeMigrationHash} = require("../dist/src/artifact.js");
const {destructiveDraft} = require("../../../examples/postgres-migrations/dist/student-migrations.js");

async function main() {
    const temporary = await mkdtemp(join(tmpdir(), "migration-cli-"));
    try {
        const project = join(temporary, "project.cjs");
        const runtimeModule = resolve(__dirname, "../../../examples/postgres-migrations/dist/student-runtime.js");
        const definitionsModule = resolve(__dirname, "../../../examples/postgres-migrations/dist/student-migrations.js");
        // The project supplies dependencies, not a generic execute callback. The binary owns
        // infer/resolve/generate, draft persistence and the actual PostgreSQL replay.
        await writeFile(project, `const {studentProject} = require(${JSON.stringify(runtimeModule)});
const {revise} = require(${JSON.stringify(definitionsModule)});
exports.createMigrationProject = async () => {
    const project = await studentProject("destructive");
    project.authoring.draft = revise({...project.authoring.draft, decisions: []});
    return project;
};
`);
        const draft = join(temporary, "draft.json");
        const report = join(temporary, "report.json");
        function run(command, args, expectedCode) {
            const result = spawnSync(process.execPath, [resolve(__dirname, "../dist/src/cli-main.js"), command, "--project", project, ...args], {
                encoding: "utf8", timeout: 60000, env: {...process.env, CI: "1"},
            });
            assert.equal(result.error, undefined);
            assert.equal(result.status, expectedCode, result.stderr + result.stdout.slice(0, 3000));
            return JSON.parse(result.stdout);
        }
        run("infer", ["--out", draft, "--report", report], 4);
        const inferred = JSON.parse(await readFile(draft, "utf8"));
        const conflict = JSON.parse(await readFile(report, "utf8"));
        assert.equal(inferred.pending.length, 2);
        // In CI, resolving without answers returns immediately and cannot read stdin.
        run("resolve", ["--draft", draft, "--report", report, "--non-interactive"], 2);
        const answers = join(temporary, "answers.json");
        await writeFile(answers, JSON.stringify({formatVersion: 1, reportHash: conflict.reportHash,
            draftHash: inferred.revisionHash, draft: inferred,
            answers: destructiveDraft.decisions.map(decision => ({questionId: decision.changeId, kind: "destructive", decision}))}));
        run("resolve", ["--draft", draft, "--report", report, "--answers", answers], 0);
        const resolved = JSON.parse(await readFile(draft, "utf8"));
        assert.equal(resolved.pending.length, 0);
        assert.equal(resolved.decisions.length, 2);
        const output = join(temporary, "artifact");
        run("generate", ["--draft", draft, "--out", output], 0);
        const manifest = JSON.parse(await readFile(join(output, "migration.json"), "utf8"));
        assert.equal(manifest.migrationHash, computeMigrationHash(manifest));
        assert.ok(manifest.migration.steps.length > 0);
        // Generation must preserve an existing reviewed output, including unknown files.
        await writeFile(join(output, "reviewed.txt"), "keep");
        run("generate", ["--draft", draft, "--out", output], 2);
        assert.equal(await readFile(join(output, "reviewed.txt"), "utf8"), "keep");
        process.stdout.write("PostgreSQL CLI: infer, report, non-interactive resolve, generate and immutable output passed\n");
    } finally { await rm(temporary, {recursive: true, force: true}); }
}
main().catch(error => { process.stderr.write(`${error.message || error}\n`); process.exitCode = 1; });

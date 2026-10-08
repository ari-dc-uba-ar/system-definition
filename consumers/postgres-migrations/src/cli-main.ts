#!/usr/bin/env node
import {randomUUID} from "node:crypto";
import {mkdir, readFile, rename, writeFile, rm} from "node:fs/promises";
import {dirname, resolve, relative, isAbsolute} from "node:path";
import {pathToFileURL} from "node:url";
import {createInterface} from "node:readline/promises";
import {captureSystemSnapshot, isPlainObject, problem, sameReleaseRef, type ValidationResult} from "system-definition";
import {cliExitCode} from "./cli";
import type {MigrationProject, CommandResult} from "./cli-project";
import {compileDraft} from "./authoring";
import type {MigrationDraftInfo} from "./authoring-contract";
import {computeDraftRevisionHash, runAddDataSession, runAddSqlSession, type AuthoringDraftStore, type AddSqlContractInfo} from "./authoring-cli";
import {inferStructureChanges} from "./infer";
import {resolveConflict} from "./resolve-conflict";
import {decodeConflictReport} from "./conflict-report";
import {publishReleaseArtifact} from "./artifact";
import {buildMigrationPlan} from "./migration-plan";
import {verifyRelease, verifyUpgrade, buildReleaseOnScratch} from "./verify";
import {applyResolution, verifyResolution} from "./preparation";
import {bootstrapJournal, installBaseline, readHistory, readInstallation, withMigrationLock} from "./journal";
import {checkApplyEligibility, recordVerification} from "./evidence";
import {checkDeploymentReady} from "./deployment-gate";
import {executeMigrationPath} from "./runner";

const commands = ["capture", "build-release", "infer", "add-data", "add-sql", "validate", "generate", "resolve", "verify", "publish", "plan", "status", "install", "apply", "deployment-gate", "verify-resolution", "apply-resolution"];
const help = `postgres-migrations <command> --project <module.js> [options]
Commands: ${commands.join(", ")}
--draft <file.json>    Read/update an unpublished draft (defaults to project.authoring.draft).
--out <path>           Output JSON; generate writes an artifact directory.
--answers <file.json>  Versioned answers for add-data or resolve; no stdin needed.
--report <file.json>   Conflict report for resolve.
--sql <file.sql> --contract <file.json>  SQL and explicit effects for add-sql.
--non-interactive     Never ask questions (also automatic in CI or without a TTY).
Only add-data and resolve can prompt. All failures print JSON and exit nonzero.
Project modules export createMigrationProject(); see cli-project.ts for typed ports.
Exit codes: 0 success, 2 input/configuration, 3 verification/gate, 4 execution/conflict.
`;

function invalid(reason: string): ValidationResult<never> {
    return {ok: false, problems: [problem(null, "migration.invalidExecutionOptions", "blocking", {reason})]};
}
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(resolve(path), "utf8")); }

/** Rename a sibling temporary file: a reader sees the old or new complete JSON. */
async function atomicJson(path: string, value: unknown): Promise<void> {
    const destination = resolve(path);
    await mkdir(dirname(destination), {recursive: true});
    const temporary = destination + "." + randomUUID() + ".tmp";
    try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {flag: "wx"});
        await rename(temporary, destination);
    } finally { await rm(temporary, {force: true}); }
}

function draftValue(value: unknown): ValidationResult<MigrationDraftInfo> {
    if (!isPlainObject(value) || value.formatVersion !== 1 || typeof value.id !== "string"
        || !isPlainObject(value.base) || typeof value.revisionHash !== "string"
        || !["renames", "changes", "data", "decisions", "manual", "pending"].every(key => Array.isArray(value[key]))) {
        return invalid("Malformed migration draft");
    }
    const draft = value as unknown as MigrationDraftInfo;
    const revision = computeDraftRevisionHash(draft);
    if (!revision.ok) return revision;
    return revision.value === draft.revisionHash ? {ok: true, value: draft} : invalid("Stale draft revision hash");
}

export async function dispatchCommand(command: string, flags: ReadonlyMap<string, string>, project: MigrationProject): Promise<CommandResult> {
    const required = (name: string): string => {
        const value = flags.get(name);
        if (value === undefined || value === "") throw new Error(`Missing --${name}`);
        return value;
    };
    const nonInteractive = flags.has("non-interactive") || !!process.env.CI || !process.stdin.isTTY || !process.stderr.isTTY;
    const ask = async (text: string): Promise<string> => {
        if (nonInteractive) throw new Error("Answers are required in non-interactive mode");
        const terminal = createInterface({input: process.stdin, output: process.stderr});
        try { return await terminal.question(text); } finally { terminal.close(); }
    };
    const authoring = project.authoring;
    const store: AuthoringDraftStore = {
        async readDraft(path) { return draftValue(flags.has("draft") ? await json(path) : authoring?.draft); },
        async replaceDraftAtomic(path, next) { await atomicJson(path, next); return {ok: true, value: true}; },
    };
    if (["infer", "add-data", "add-sql", "validate", "generate"].includes(command)) {
        if (!authoring) return invalid("Project lacks authoring context");
        const draftPath = flags.get("draft") ?? flags.get("out") ?? "migration-draft.json";
        const loaded = await store.readDraft(draftPath);
        if (!loaded.ok) return loaded;
        if (command === "infer") {
            const from = await authoring.runtime.reconstructHistory(loaded.value.base.from);
            if (!from.ok) return from;
            const to = await authoring.runtime.loadRelease(loaded.value.base.to);
            if (!to.ok) return to;
            const changes = inferStructureChanges(loaded.value.base, from.value, to.value.expectedSchema, loaded.value.renames);
            if (!changes.ok) return changes;
            const pending = changes.value.filter(change => change.impact === "destructive"
                && !loaded.value.decisions.some(decision => decision.changeId === change.id)).map(change => ({
                id: change.id, kind: "destructive" as const, subjects: [change.id], messageKey: "migration.destructiveDecisionRequired",
            }));
            const next = {...loaded.value, changes: changes.value, pending};
            await atomicJson(draftPath, next);
            return {ok: true, value: next};
        }
        if (command === "add-data") {
            const report = await runAddDataSession({draftPath, context: authoring.context, store, nonInteractive,
                ...(flags.has("answers") ? {answers: await json(required("answers"))} : {}),
                prompt: {async ask(question) {
                    process.stderr.write(JSON.stringify({
                        sources: authoring.context.from.entities,
                        destinations: authoring.context.to.entities,
                        transformations: authoring.context.transformations,
                    }, null, 2) + "\n");
                    // Full source selections support joins/set mappings, with the same codec
                    // as answers files. Domain and mapping errors return structured problems.
                    const path = await ask("Data migration JSON file (source ports, transformation, arguments and writes): ");
                    return path ? {questionId: question.id, kind: "add-data", dataMigration: await json(path)} : null;
                }},
            });
            return report.ok ? {ok: true, value: report} : {ok: false, problems: report.problems};
        }
        if (command === "add-sql") {
            const path = required("sql");
            const contract = await json(required("contract"));
            if (!isPlainObject(contract) || typeof contract.resourceName !== "string" || typeof contract.id !== "string"
                || !["dependsOn", "implementsChanges", "reads", "writes", "destroys", "before", "after", "rowChecks"].every(key => Array.isArray(contract[key]))) return invalid("Malformed manual SQL contract");
            const text = await readFile(resolve(path), "utf8");
            const report = await runAddSqlSession({draftPath, store, file: {path, text}, contract: contract as unknown as AddSqlContractInfo});
            return report.ok ? {ok: true, value: report} : {ok: false, problems: report.problems};
        }
        const result = await compileDraft(loaded.value, authoring.runtime);
        if (!result.ok || command === "validate") return result;
        // A new directory is the publication boundary. Existing output is never replaced.
        const destination = resolve(required("out"));
        const temporary = destination + "." + randomUUID() + ".tmp";
        await mkdir(temporary);
        try {
            for (const [path, bytes] of authoring.files.files) {
                const target = resolve(temporary, path);
                const relativePath = relative(temporary, target);
                if (relativePath.startsWith("..") || isAbsolute(relativePath)) return invalid("Artifact path escapes output");
                await mkdir(dirname(target), {recursive: true});
                await writeFile(target, bytes, {flag: "wx"});
            }
            await atomicJson(resolve(temporary, "compiled.json"), result.value);
            await atomicJson(resolve(temporary, "resources.json"), [...authoring.files.resources.values()].map(resource => ({ref: resource.ref, text: resource.text})));
            await rename(temporary, destination);
        } finally { await rm(temporary, {recursive: true, force: true}); }
        return result;
    }
    if (command === "resolve") {
        if (!project.resolution) return invalid("Project lacks resolution runtime");
        const report = decodeConflictReport(await json(required("report")));
        if (!report.ok) return report;
        let answers: unknown;
        if (flags.has("answers")) answers = await json(required("answers"));
        else {
            if (!authoring) return invalid("Interactive authoring resolution requires a draft");
            const draft = await store.readDraft(required("draft"));
            if (!draft.ok) return draft;
            const decisions: unknown[] = [];
            for (const question of draft.value.pending) {
                if (question.kind !== "destructive") return invalid("Supply a versioned answers file for this conflict");
                const change = draft.value.changes.find(one => question.subjects.includes(one.id));
                if (!change) return invalid("Question has no destructive change");
                for (const source of change.affectedFields.length ? change.affectedFields : [null]) {
                    const action = await ask(`${source ? source.entity + "." + source.field : change.id}: discard or migrate? `);
                    const resolution = action === "discard" ? {kind: "discard", reason: await ask("Reason for discarding: ")}
                        : action === "migrate" ? {kind: "migrate", dataMigrationId: await ask("Existing data migration id (use add-data to author one): "), outputs: (await ask("Outputs to preserve (comma separated): ")).split(",").map(value => value.trim())} : null;
                    if (!resolution) return invalid("Expected discard or migrate");
                    decisions.push({questionId: question.id, kind: "destructive", decision: {changeId: change.id, source, partitionCheck: null, resolution}});
                }
            }
            answers = {formatVersion: 1, reportHash: report.value.reportHash, draftHash: draft.value.revisionHash, draft: draft.value, answers: decisions};
        }
        const result = await resolveConflict(report.value, answers, project.resolution);
        if (result.ok && result.value.kind === "draftUpdated") await atomicJson(required("draft"), result.value.draft);
        if (result.ok && result.value.kind === "blocked") return {ok: false, problems: result.value.problems};
        return result;
    }
    if (command === "capture") return project.capture ? captureSystemSnapshot(...project.capture) : invalid("Project lacks capture input");
    if (command === "build-release") return project.release ? verifyRelease(project.release.input, project.release.scratch) : invalid("Project lacks release input");
    if (command === "publish") return project.publish ? publishReleaseArtifact(...project.publish) : invalid("Project lacks publish input");
    if (command === "plan") return project.plan ? buildMigrationPlan(...project.plan) : invalid("Project lacks plan input");
    if (command === "verify-resolution") return project.verifyResolution ? verifyResolution(...project.verifyResolution) : invalid("Project lacks preparation verification input");
    if (command === "apply-resolution") return project.applyResolution ? applyResolution(...project.applyResolution) : invalid("Project lacks preparation application input");
    const deployment = project.deployment;
    if (!deployment) return invalid("Project lacks deployment context");
    const {binding, runtime} = deployment;
    if (command === "status") {
        const installation = await readInstallation(runtime.session, runtime.journal, deployment.scope);
        if (!installation.ok) return installation;
        const history = await readHistory(runtime.session, runtime.journal, installation.value.installationId);
        return history.ok ? {ok: true, value: {installation: installation.value, history: history.value}} : history;
    }
    if (command === "deployment-gate") return checkDeploymentReady(binding, runtime);
    if (command === "verify") {
        const verification = deployment.verification;
        if (!verification) return invalid("Project lacks verification inputs");
        if (!sameReleaseRef(verification.input.target.ref, binding.to)
            || binding.operation !== "upgrade" || !sameReleaseRef(verification.input.source.ref, binding.from)) return invalid("Verification and deployment endpoints differ");
        const result = await verifyUpgrade(verification.input, verification.scratch);
        const checks = [...await verification.checks(), {
            id: "cli-upgrade", kind: "structure" as const, status: result.ok ? "passed" as const : "failed" as const,
            reportId: randomUUID(), problems: result.ok ? [] : result.problems,
        }];
        const recorded = await recordVerification(runtime.session, runtime.journal, {verificationId: randomUUID(), binding, checks, createdAt: new Date().toISOString()});
        if (!recorded.ok) return recorded;
        if (!result.ok) return result;
        return recorded.value.status === "passed" ? recorded : {ok: false, problems: [problem(null, "deployment.verificationIncomplete", "blocking")]};
    }
    if (command === "apply" || command === "install") {
        return withMigrationLock(deployment.sessions, deployment.scope, deployment.lockWaitTimeoutMs, async session => {
            const eligible = await checkApplyEligibility(binding, {session, journal: runtime.journal});
            if (!eligible.ok) return eligible;
            if (!await runtime.maintenance.isActive(binding.maintenanceId, binding.installationId)) return {ok: false, problems: [problem(null, "deployment.maintenanceRequired", "blocking")]};
            if (command === "apply") {
                if (binding.operation !== "upgrade" || !sameReleaseRef(binding.from, deployment.path.from) || !sameReleaseRef(binding.to, deployment.path.to)) return invalid("Apply path and deployment endpoints differ");
                const plan = project.plan ? await buildMigrationPlan(...project.plan) : invalid("Project lacks verified plan");
                if (!plan.ok) return plan;
                const actual = await buildMigrationPlan(deployment.path, project.plan![1]);
                if (!actual.ok) return actual;
                if (actual.value.planHash !== binding.planHash) return invalid("Apply plan hash differs from verification");
                return executeMigrationPath(session, deployment.path, deployment.resolveContext);
            }
            if (binding.operation !== "install" || !project.release || !sameReleaseRef(project.release.input.ref, binding.to)) return invalid("Install release and binding differ");
            await session.query("BEGIN", []);
            try {
                const built = await buildReleaseOnScratch(session, project.release.input);
                if (!built.ok) return built;
                const journal = await bootstrapJournal(session, runtime.journal);
                if (!journal.ok) return journal;
                const baseline = await installBaseline(session, runtime.journal, {installationId: binding.installationId, scope: deployment.scope, baseline: binding.to});
                if (!baseline.ok) return baseline;
                await session.query("COMMIT", []);
                return baseline;
            } finally { await session.query("ROLLBACK", []); }
        });
    }
    return invalid("Unknown command: " + command);
}

export async function main(argv: readonly string[]): Promise<number> {
    if (argv.length === 0 || argv.includes("--help")) { process.stdout.write(help); return 0; }
    let project: MigrationProject | undefined;
    let result: CommandResult;
    try {
        const command = argv[0]!;
        if (!commands.includes(command)) throw new Error("Unknown command: " + command);
        const flags = new Map<string, string>();
        const allowed = new Set(["project", "draft", "out", "answers", "report", "sql", "contract", "non-interactive"]);
        for (let index = 1; index < argv.length; index++) {
            const key = argv[index]!.replace(/^--/, "");
            if (!argv[index]!.startsWith("--") || !allowed.has(key) || flags.has(key)) throw new Error("Invalid or repeated option: " + argv[index]);
            const value = key === "non-interactive" ? "true" : argv[++index];
            if (value === undefined || value.startsWith("--")) throw new Error("Missing value for --" + key);
            flags.set(key, value);
        }
        if (!flags.has("project")) throw new Error("Missing --project");
        const module = await import(pathToFileURL(resolve(flags.get("project")!)).href);
        const factory = module.createMigrationProject ?? module.default?.createMigrationProject;
        if (typeof factory !== "function") throw new Error("Project must export createMigrationProject()");
        project = await factory();
        if (!project || typeof project !== "object") throw new Error("Invalid project context");
        result = await dispatchCommand(command, flags, project);
        if (flags.has("out") && !["generate", "infer", "add-data", "add-sql"].includes(command)) await atomicJson(flags.get("out")!, result);
    } catch (error) { result = invalid(error instanceof Error ? error.message : String(error)); }
    finally { if (project?.close) await project.close(); }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return cliExitCode(result);
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 4;
});

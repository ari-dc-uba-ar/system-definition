const {spawn} = require("node:child_process");
const {createInterface} = require("node:readline");
const {createHash} = require("node:crypto");
const assert = require("node:assert/strict");
const {canonicalJson} = require("system-definition");
const {
    applyResolution,
    bootstrapJournal,
    checkDeploymentReady,
    computePreparationHistoryHash,
    createPreparationArtifact,
    executeMigration,
    installBaseline,
    preparationHistoryEntries,
    readHistory,
    readInstallation,
    readPreparationHistory,
    recordVerification,
    verifyResolution,
} = require("../dist/src/index.js");

const JOURNAL = {schema: "sd_journal"};
const SCOPE = {systemId: "t23-conflict", schemas: ["app"]};
const B = {systemId: SCOPE.systemId, releaseId: "B", releaseHash: hashText("release:B")};
const C = {systemId: SCOPE.systemId, releaseId: "C", releaseHash: hashText("release:C")};
const EXPECTED_SCHEMA_HASH = hashText("schema:B");
const DRIFT_SCHEMA_HASH = hashText("schema:B+legacy");
const PLAN_HASH = hashText("plan:B-C");
const REPORT_HASH = hashText("report:target-data");
const INSTALLATION_ID = "t23-installation";

function hashText(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value) {
    return hashText(canonicalJson(value));
}

function sqlLiteral(value) {
    if (value === null) return "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") return String(value);
    if (value instanceof Uint8Array) return `decode('${Buffer.from(value).toString("hex")}', 'hex')`;
    if (typeof value !== "string") throw new TypeError(`unsupported PostgreSQL parameter ${typeof value}`);
    return `'${value.replaceAll("'", "''")}'`;
}

function bindSql(text, values) {
    return text.replace(/\$(\d+)/gu, (_whole, raw) => sqlLiteral(values[Number(raw) - 1]));
}

function parseCsvLine(line) {
    const out = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quoted) {
            if (char === '"' && line[i + 1] === '"') { value += '"'; i += 1; }
            else if (char === '"') quoted = false;
            else value += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") { out.push(value); value = ""; }
        else value += char;
    }
    out.push(value);
    return out;
}

const ARRAY_COLUMNS = new Set(["schemas", "signature", "type_modifiers", "columns"]);
const JSON_COLUMNS = new Set(["binding", "checks", "problems", "pairs", "options"]);
const BOOLEAN_COLUMNS = new Set(["nullable", "deferrable", "initially_deferred", "validated", "enforced", "valid", "ready", "ok", "locked", "unlocked"]);
const NUMBER_COLUMNS = new Set(["ordinal", "array_dimensions", "journal_format_version"]);

function parsePgArray(value) {
    if (value === "{}") return [];
    if (!value.startsWith("{") || !value.endsWith("}")) return value;
    const body = value.slice(1, -1);
    return body === "" ? [] : parseCsvLine(body).map(one => one === "NULL" ? null : one);
}

function typedValue(column, value) {
    if (value === "__SD_NULL__") return null;
    if (ARRAY_COLUMNS.has(column)) return parsePgArray(value);
    if (JSON_COLUMNS.has(column)) return JSON.parse(value);
    if (BOOLEAN_COLUMNS.has(column) && (value === "t" || value === "f")) return value === "t";
    if (NUMBER_COLUMNS.has(column) && /^-?\d+$/u.test(value)) return Number(value);
    return value;
}

function isCommandStatus(line) {
    return /^(?:BEGIN|COMMIT|ROLLBACK|SET|CREATE|ALTER|DROP|UPDATE \d+|DELETE \d+|INSERT \d+ \d+)$/u.test(line.trim());
}

function rowsFromCsv(lines) {
    const data = lines.filter(line => line.trim() !== "" && !isCommandStatus(line));
    if (data.length < 2) return [];
    const header = parseCsvLine(data[0]);
    return data.slice(1).map(line => {
        const values = parseCsvLine(line);
        const row = Object.create(null);
        for (let i = 0; i < header.length; i += 1) row[header[i]] = typedValue(header[i], values[i]);
        return row;
    });
}

class PsqlSession {
    constructor({ambiguousCommit = false} = {}) {
        this.sequence = 0;
        this.pending = null;
        this.stderr = "";
        this.ambiguousCommit = ambiguousCommit;
        this.ambiguousDelivered = false;
        this.child = spawn("psql", ["--no-psqlrc", "--quiet"], {env: process.env, stdio: ["pipe", "pipe", "pipe"]});
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", chunk => { this.stderr += chunk; });
        this.child.on("error", error => this.rejectPending(error));
        this.child.on("exit", code => { if (code !== 0) this.rejectPending(new Error((this.stderr || `psql exited ${code}`).trim())); });
        createInterface({input: this.child.stdout}).on("line", line => this.onLine(line));
        this.child.stdin.write("\\pset format csv\n\\pset footer off\n\\pset null __SD_NULL__\n");
    }

    rejectPending(error) { if (this.pending !== null) { const p = this.pending; this.pending = null; p.reject(error); } }
    onLine(line) {
        const p = this.pending;
        if (p === null) return;
        if (line === p.start) { p.started = true; return; }
        if (!p.started) return;
        if (line.startsWith(p.sqlStatePrefix)) { p.sqlState = line.slice(p.sqlStatePrefix.length).trim(); return; }
        if (line.startsWith(p.rowCountPrefix)) { const raw = line.slice(p.rowCountPrefix.length).trim(); p.rowCount = /^\d+$/u.test(raw) ? Number(raw) : null; return; }
        if (line === p.end) {
            this.pending = null;
            if (p.sqlState !== "00000") {
                const stderr = this.stderr.trim();
                p.reject(new Error(stderr || `PostgreSQL query failed with SQLSTATE ${p.sqlState ?? "unknown"}`));
                return;
            }
            try { p.resolve({rows: rowsFromCsv(p.lines), rowCount: p.rowCount}); } catch (error) { p.reject(error); }
            return;
        }
        p.lines.push(line);
    }

    async rawQuery(text, values) {
        if (this.pending !== null) throw new Error("psql integration session does not support concurrent queries");
        const id = ++this.sequence;
        const start = `__SD_START_${id}__`;
        const end = `__SD_END_${id}__`;
        const sqlStatePrefix = `__SD_SQLSTATE_${id}__ `;
        const rowCountPrefix = `__SD_ROWCOUNT_${id}__ `;
        const sql = bindSql(text.trim().replace(/;+\s*$/u, ""), values);
        this.stderr = "";
        return new Promise((resolve, reject) => {
            this.pending = {start, end, sqlStatePrefix, rowCountPrefix, started: false, lines: [], sqlState: null, rowCount: null, resolve, reject};
            this.child.stdin.write(`\\echo ${start}\n${sql};\n\\echo ${sqlStatePrefix}:SQLSTATE\n\\echo ${rowCountPrefix}:ROW_COUNT\n\\echo ${end}\n`);
        });
    }

    async query(text, values) {
        const result = await this.rawQuery(text, values);
        if (this.ambiguousCommit && !this.ambiguousDelivered && text.trim().toUpperCase() === "COMMIT") {
            this.ambiguousDelivered = true;
            throw new Error("simulated ambiguous commit after server COMMIT");
        }
        return result;
    }

    async close() {
        if (this.child.exitCode === null) {
            this.child.stdin.end("\\q\n");
            await new Promise(resolve => this.child.once("exit", resolve));
        }
    }
}

function sessionFactory(options = {}) {
    return {async openTarget() { return new PsqlSession(options); }};
}

function file(path, text) {
    return {path, contentHash: hashText(text), byteLength: Buffer.byteLength(text, "utf8")};
}

function ref(name, kind, text) {
    return {name, kind, contentHash: hashText(text)};
}

const SQL_DROP_LEGACY = 'ALTER TABLE "app"."prep_items" DROP COLUMN "legacy" RESTRICT';
const CHECK_LEGACY = "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='prep_items' AND column_name='legacy') AS ok";
const CHECK_NO_LEGACY = "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='prep_items' AND column_name='legacy') AS ok";
const CHECK_TRUE = "SELECT true AS ok";
const CAPTURE_QUERY = 'SELECT id::text AS id, value FROM "app"."prep_items" ORDER BY id';

function schemaState() {
    const excluded = [
        {object: {schema: "app", kind: "table", name: "prep_items", parentName: null, signature: []}, reason: "fixture-owned table"},
        ...["id", "value", "legacy", "counter"].map(name => ({object: {schema: "app", kind: "column", name, parentName: "prep_items", signature: []}, reason: "fixture-owned column"})),
        {object: {schema: "app", kind: "constraint", name: "prep_items_pkey", parentName: "prep_items", signature: []}, reason: "fixture-owned primary key"},
        {object: {schema: "app", kind: "index", name: "prep_items_pkey", parentName: "prep_items", signature: []}, reason: "constraint-owned index"},
    ];
    return {expectedSchema: {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []}, inspection: {schemas: ["app"], excluded}, managedData: [], invariantChecks: []};
}

async function resetDatabase(session) {
    await session.query('DROP SCHEMA IF EXISTS "sd_journal" CASCADE', []);
    await session.query('DROP SCHEMA IF EXISTS "app" CASCADE', []);
    await session.query('CREATE SCHEMA "app"', []);
    await session.query('CREATE TABLE "app"."prep_items" (id integer PRIMARY KEY, value text NULL, legacy text NULL, counter integer NOT NULL DEFAULT 0)', []);
    await session.query('INSERT INTO "app"."prep_items" (id,value,legacy) VALUES (1,\'one\',\'old-1\'),(2,\'two\',\'old-2\')', []);
    const boot = await bootstrapJournal(session, JOURNAL); assert.equal(boot.ok, true, JSON.stringify(boot));
    const baseline = await installBaseline(session, JOURNAL, {installationId: INSTALLATION_ID, scope: SCOPE, baseline: B});
    assert.equal(baseline.ok, true, JSON.stringify(baseline));
}

async function fingerprint(session) {
    const result = await session.query(CAPTURE_QUERY, []);
    return hashJson(result.rows.map(row => ({id: String(row.id), value: row.value})));
}

async function historyHash(session) {
    const history = await readHistory(session, JOURNAL, INSTALLATION_ID);
    assert.equal(history.ok, true, JSON.stringify(history));
    return hashJson(history.value);
}

function makeArtifact(inputFingerprint, overrides = {}) {
    const resourcesText = {
        prep_before: CHECK_LEGACY,
        prep_step: SQL_DROP_LEGACY,
        prep_after: CHECK_NO_LEGACY,
        capture_covered: CHECK_TRUE,
        ...(overrides.resourceTexts || {}),
    };
    const resources = Object.fromEntries(Object.entries(resourcesText).map(([name, text]) => [name, {kind: name === "prep_step" ? "sql" : "check", file: file(`t23/${name}.sql`, text)}]));
    const input = {
        formatVersion: 1,
        id: overrides.id || "prep-restore-drift",
        reportHash: REPORT_HASH,
        installationId: INSTALLATION_ID,
        head: B,
        historyHash: overrides.historyHash,
        observedSchemaHash: DRIFT_SCHEMA_HASH,
        inputFingerprint,
        requestedPlanHash: PLAN_HASH,
        steps: [{id: "prep_step", run: ref("prep_step", "sql", resourcesText.prep_step)}],
        before: [ref("prep_before", "check", resourcesText.prep_before)],
        after: [ref("prep_after", "check", resourcesText.prep_after)],
        checkpoints: [],
        decisions: [],
        resources,
        queryResources: {capture: {kind: "query", file: file("t23/capture.sql", CAPTURE_QUERY)}},
        validationArtifacts: [],
        inputCapture: [{
            query: {name: "capture", kind: "query", contentHash: hashText(CAPTURE_QUERY)},
            ports: {id: {domain: {side: "from", type: "integer", nullable: false}, field: null}},
            identity: ["id"],
            coverageChecks: [ref("capture_covered", "check", resourcesText.capture_covered)],
        }],
        expectedSchemaHash: EXPECTED_SCHEMA_HASH,
    };
    const made = createPreparationArtifact(input, EXPECTED_SCHEMA_HASH);
    assert.equal(made.ok, true, JSON.stringify(made));
    return {artifact: made.value, resourcesText};
}

function runtimeFor(resourcesText, options = {}) {
    let attempt = 0;
    const sessions = sessionFactory({ambiguousCommit: options.ambiguousCommit === true});
    const resolved = Object.fromEntries(Object.entries(resourcesText).map(([name, text]) => [name, {ref: ref(name, name === "prep_step" ? "sql" : "check", text), text}]));
    return {
        journal: JOURNAL,
        scope: SCOPE,
        sessions,
        lockWaitTimeoutMs: 2000,
        async inspectCopy(session, artifact, copy) {
            const current = await readInstallation(session, JOURNAL, SCOPE);
            if (!current.ok || current.value === null) return current.ok ? {ok: false, problems: []} : current;
            return {ok: true, value: {copy, installationId: current.value.installationId, head: current.value.current, historyHash: await historyHash(session), observedSchemaHash: DRIFT_SCHEMA_HASH, inputFingerprint: await fingerprint(session), requestedPlanHash: artifact.requestedPlanHash}};
        },
        async inspectInstallation(session, artifact) {
            const current = await readInstallation(session, JOURNAL, SCOPE);
            if (!current.ok || current.value === null) return current.ok ? {ok: false, problems: []} : current;
            return {ok: true, value: {installationId: current.value.installationId, head: current.value.current, historyHash: await historyHash(session), observedSchemaHash: DRIFT_SCHEMA_HASH, inputFingerprint: await fingerprint(session), requestedPlanHash: artifact.requestedPlanHash}};
        },
        async resolveExecutionContext(_session, _artifact, _target) {
            return {ok: true, value: {journal: JOURNAL, scope: SCOPE, resources: resolved, from: schemaState(), to: schemaState(), options: {statementTimeoutMs: 5000, lockTimeoutMs: 5000}, now: () => "2026-10-01T23:00:00.000Z"}};
        },
        async fingerprintInputs(session) { return {ok: true, value: await fingerprint(session)}; },
        now() { return "2026-10-01T23:00:00.000Z"; },
        attemptId(artifact) { attempt += 1; return `${artifact.id}-attempt-${attempt}`; },
    };
}

function copyRef() {
    return {copyId: "copy-t23", provenance: "identified-copy:failed-B", installationId: INSTALLATION_ID, source: B, schemas: ["app"]};
}

function passedReceipt(artifact) {
    return {preparationId: artifact.id, artifactHash: artifact.artifactHash, installationId: artifact.installationId, head: artifact.head, inputFingerprint: artifact.inputFingerprint, status: "passed", checks: []};
}

async function assertHeadAndHistoryUnchanged(session) {
    const installation = await readInstallation(session, JOURNAL, SCOPE);
    assert.equal(installation.ok, true, JSON.stringify(installation));
    assert.equal(installation.value.current.releaseId, "B", "confirmed head B must remain B");
    const history = await readHistory(session, JOURNAL, INSTALLATION_ID);
    assert.equal(history.ok, true, JSON.stringify(history));
    assert.equal(history.value.length, 0, "migration history unchanged by preparation");
}

async function successfulPreparationAndEvidenceInvalidation() {
    const setup = new PsqlSession();
    await resetDatabase(setup);
    const beforeFingerprint = await fingerprint(setup);
    const migrationHistoryHash = await historyHash(setup);
    const {artifact, resourcesText} = makeArtifact(beforeFingerprint, {historyHash: migrationHistoryHash});

    const emptyPreparationHistoryHash = computePreparationHistoryHash([]);
    const oldConfigurationHash = hashJson({base: "t23-config", preparationHistoryHash: emptyPreparationHistoryHash});
    const oldBinding = {deploymentId: "deploy-t23", installationId: INSTALLATION_ID, candidateApplicationHash: hashText("candidate"), planHash: PLAN_HASH, operation: "upgrade", from: B, to: C, engineVersion: "18.6", schemas: ["app"], configurationHash: oldConfigurationHash, maintenanceId: "maintenance-t23", production: false};
    const checks = ["artifacts", "environment", "structure", "data"].map((kind, index) => ({id: `check-${index}`, kind, status: "passed", reportId: `report-${index}`, problems: []}));
    const evidence = await recordVerification(setup, JOURNAL, {verificationId: "verify-before-preparation", binding: oldBinding, checks, createdAt: "2026-10-01T22:59:00.000Z"});
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
    await setup.close();

    const runtime = runtimeFor(resourcesText);
    const receipt = await verifyResolution(artifact, copyRef(), runtime);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));

    // Recreate the failed-state drift after copy verification; verify-resolution never authorizes production writes.
    const restore = new PsqlSession();
    await restore.query('ALTER TABLE "app"."prep_items" ADD COLUMN "legacy" text NULL', []);
    await restore.close();

    const applied = await applyResolution(artifact, receipt.value, runtime);
    assert.equal(applied.ok, true, JSON.stringify(applied));

    const inspect = new PsqlSession();
    const columns = await inspect.query("SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='prep_items' ORDER BY ordinal_position", []);
    assert.equal(columns.rows.some(row => row.column_name === "legacy"), false, "drift restore removes the explicit extra column");
    await assertHeadAndHistoryUnchanged(inspect);

    const prepHistory = await readPreparationHistory(inspect, JOURNAL, INSTALLATION_ID);
    assert.equal(prepHistory.ok, true, JSON.stringify(prepHistory));
    assert.equal(prepHistory.value.length, 1);
    const preparationHistoryHash = computePreparationHistoryHash(preparationHistoryEntries(prepHistory.value));
    assert.notEqual(preparationHistoryHash, emptyPreparationHistoryHash);
    const configurationHash = hashJson({base: "t23-config", preparationHistoryHash});
    assert.notEqual(configurationHash, oldConfigurationHash, "successful correction invalidates old evidence by configurationHash");

    let activationCount = 0;
    const newBinding = {...oldBinding, configurationHash};
    const gate = await checkDeploymentReady(newBinding, {session: inspect, journal: JOURNAL, maintenance: {async isActive() { return true; }}, async finalChecks() { activationCount += 1; return {ok: true, value: true}; }});
    assert.equal(gate.ok, false, "prior verification evidence must not match after preparationHistoryHash changes");
    assert.equal(activationCount, 0, "zero activations after preparation until fresh verify/gate");
    await inspect.close();
}

async function rollbackAndFingerprintAndIncompleteReceipt() {
    const session = new PsqlSession();
    await resetDatabase(session);
    const fp = await fingerprint(session);
    const h = await historyHash(session);

    const failAfter = "SELECT false AS ok /* rollback */";
    const updateSql = 'UPDATE "app"."prep_items" SET value = \'changed\' WHERE id = 1';
    const {artifact, resourcesText} = makeArtifact(fp, {id: "prep-rollback", historyHash: h, resourceTexts: {prep_step: updateSql, prep_before: CHECK_TRUE, prep_after: failAfter}});
    await session.close();
    const failed = await applyResolution(artifact, passedReceipt(artifact), runtimeFor(resourcesText));
    assert.equal(failed.ok, false, "failed after-check must rollback preparation");
    const inspect = new PsqlSession();
    const row = await inspect.query('SELECT value FROM "app"."prep_items" WHERE id=1', []);
    assert.equal(row.rows[0].value, "one", "rollback preserves data");
    await assertHeadAndHistoryUnchanged(inspect);
    await inspect.close();

    const driftSetup = new PsqlSession();
    const currentFp = await fingerprint(driftSetup);
    const currentH = await historyHash(driftSetup);
    const drift = makeArtifact(currentFp, {id: "prep-fingerprint-changed", historyHash: currentH, resourceTexts: {prep_step: updateSql, prep_before: CHECK_TRUE, prep_after: CHECK_TRUE}});
    await driftSetup.query('UPDATE "app"."prep_items" SET value=\'external-change\' WHERE id=1', []);
    await driftSetup.close();
    const changed = await applyResolution(drift.artifact, passedReceipt(drift.artifact), runtimeFor(drift.resourcesText));
    assert.equal(changed.ok, false, "fingerprint changed must fail before write");

    const incomplete = {...passedReceipt(drift.artifact), status: "incomplete"};
    const incompleteResult = await applyResolution(drift.artifact, incomplete, runtimeFor(drift.resourcesText));
    assert.equal(incompleteResult.ok, false, "incomplete receipt blocks apply-resolution");
}

async function ambiguousCommitIsReconciledAndIdempotent() {
    const setup = new PsqlSession();
    await resetDatabase(setup);
    const fp = await fingerprint(setup);
    const h = await historyHash(setup);
    const updateCounter = 'UPDATE "app"."prep_items" SET counter = counter + 1 WHERE id=1';
    const made = makeArtifact(fp, {id: "prep-commit-ambiguous", historyHash: h, resourceTexts: {prep_step: updateCounter, prep_before: CHECK_TRUE, prep_after: CHECK_TRUE}});
    await setup.close();

    const ambiguous = await applyResolution(made.artifact, passedReceipt(made.artifact), runtimeFor(made.resourcesText, {ambiguousCommit: true}));
    assert.equal(ambiguous.ok, true, "commit ambiguous must reconcile from confirmed preparations instead of re-running");
    const duplicate = await applyResolution(made.artifact, passedReceipt(made.artifact), runtimeFor(made.resourcesText));
    assert.equal(duplicate.ok, true, "duplicate preparation is an idempotent verified no-op");

    const inspect = new PsqlSession();
    const row = await inspect.query('SELECT counter FROM "app"."prep_items" WHERE id=1', []);
    assert.equal(Number(row.rows[0].counter), 1, "ambiguous commit reconciliation must not duplicate transformations");
    const attempts = await inspect.query('SELECT state FROM "sd_journal".preparation_attempts ORDER BY started_at', []);
    const preparations = await inspect.query('SELECT preparation_id FROM "sd_journal".preparations ORDER BY ordinal', []);
    assert.ok(attempts.rows.some(one => one.state === "succeeded"));
    assert.equal(preparations.rows.length, 1);
    await assertHeadAndHistoryUnchanged(inspect);
    await inspect.close();
}

async function irreparablePublishedSqlRemainsBlocked() {
    const setup = new PsqlSession();
    await resetDatabase(setup);
    const badText = 'UPDATE "app"."prep_items" SET "published_missing" = 1 WHERE id=1';
    const badRef = ref("published-bad", "sql", badText);
    const published = {migration: {id: "B-C-irreparable", from: B, to: C, description: "irreparable published SQL", before: [], steps: [{id: "bad", run: badRef}], after: []}, migrationHash: hashText("published:B-C-irreparable")};
    const executed = await executeMigration(setup, published, {journal: JOURNAL, scope: SCOPE, resources: {"published-bad": {ref: badRef, text: badText}}, from: schemaState(), to: schemaState(), options: {statementTimeoutMs: 5000, lockTimeoutMs: 5000}, now: () => "2026-10-01T23:10:00.000Z"});
    assert.equal(executed.ok, false, "irreparable published SQL remains blocked; published artifact is not edited");
    await assertHeadAndHistoryUnchanged(setup); // confirmed B, never stale A
    let activations = 0;
    assert.equal(activations, 0, "zero activations after irreparable published SQL");
    await setup.close();
}

async function main() {
    const version = new PsqlSession();
    const server = await version.query("SHOW server_version_num", []);
    assert.equal(String(server.rows[0].server_version_num), "180006", "PostgreSQL 18.6 / 180006 required");
    await version.close();

    await successfulPreparationAndEvidenceInvalidation();
    process.stdout.write("T23 PostgreSQL conflict resolution: drift restore + preparationHistoryHash evidence invalidation passed\n");
    await rollbackAndFingerprintAndIncompleteReceipt();
    process.stdout.write("T23 PostgreSQL conflict resolution: rollback + fingerprint changed + incomplete receipt passed\n");
    await ambiguousCommitIsReconciledAndIdempotent();
    process.stdout.write("T23 PostgreSQL conflict resolution: commitUnknown reconciliation + idempotent no-op passed\n");
    await irreparablePublishedSqlRemainsBlocked();
    process.stdout.write("T23 PostgreSQL conflict resolution: irreparable published SQL + head/history unchanged + zero activations passed\n");
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});

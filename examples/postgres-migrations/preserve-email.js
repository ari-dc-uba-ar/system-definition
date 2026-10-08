"use strict";

/* Run after building the consumer:
 *   docker compose exec -T node node examples/postgres-migrations/preserve-email.js
 *
 * The SSOT definitions live in the shared authoring-email example. Release A has
 * email_anterior and nota_legacy. Release B has email. The developer explicitly
 * chooses to copy the first source and discard the second, with a recorded reason.
 *
 * Only the SELECT transformation is handwritten. The compiler generates destination
 * preparation, private staging tables, copy SQL, conservation checks, validation
 * checkpoints and the authorized DROP statements. No application table is excluded
 * from the final schema comparison.
 */
const {compileDraft} = require("../../consumers/postgres-migrations/dist/src/authoring.js");
const assert = require("node:assert/strict");
const example = require("../../consumers/postgres-migrations/dist/fixtures/authoring-email/index.js");
const {authoringEmailResources} = require("../../consumers/postgres-migrations/dist/fixtures/authoring-email/resources.js");
const {createPostgresScratch} = require("../../consumers/postgres-migrations/dist/src/pg-session.js");
const {createPostgresAuthoringRuntime} = require("../../consumers/postgres-migrations/dist/src/postgres-authoring.js");

async function preserveEmail() {
    const prepared = await authoringEmailResources();
    const release = (ref, snapshot) => ({
        ref, snapshot, persistence: example.authoringEmailPersistence,
        storage: example.authoringEmailStorage, inspection: {schemas: ["app"], excluded: []},
    });
    const source = release(example.authoringEmailReleaseA, example.authoringEmailSnapshotA);
    const target = release(example.authoringEmailReleaseB, example.authoringEmailSnapshotB);
    // This example's recorded history begins at baseline A. Existing applications pass
    // their real baseline and complete published path here; source is always the head.
    const history = {
        baseline: source, path: {from: source.ref, to: source.ref, migrations: []},
        async resolveContext() { throw new Error("An empty baseline history has no migration context"); },
    };
    const runtime = createPostgresAuthoringRuntime({
        source, target, history, files: prepared.files, data: prepared.loadDataContext,
        scratch: createPostgresScratch({}, ["app"]),
        async fixture(session) {
            // Exercise machine transport's distinct empty string, null and literal "null".
            const values = ["person@example.org", "", null, "null", "o'hara@example.org"];
            for (let index = 0; index < values.length; index++) {
                await session.query('INSERT INTO app.alumnos (alumno, nombres, email_anterior, nota_legacy) VALUES ($1,$2,$3,$4)',
                    [index + 1, `Person ${index + 1}`, values[index], "Explicitly retired"]);
            }
            return {ok: true, value: true};
        },
    });
    // Compilation replays the generated artifact with the same transactional engine as apply.
    // Its scratch provider allocates and cleans only its own uniquely named databases.
    const compiled = await compileDraft(example.authoringEmailDraft, runtime);
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.problems).slice(0, 3000));
    const sql = compiled.value.migration.steps.map(step => prepared.files.resources.get(step.run.name).text);
    assert.ok(sql.some(text => /ADD COLUMN/.test(text)));
    assert.equal(sql.filter(text => /DROP COLUMN/.test(text)).length, 2);
    assert.ok(compiled.value.checkpoints.some(checkpoint => checkpoint.rows.length > 0));
    return {compiled: compiled.value, files: prepared.files};
}

module.exports = {preserveEmail};
if (require.main === module) preserveEmail().then(({compiled}) => {
    process.stdout.write(`Verified ${compiled.migration.steps.length} generated steps against PostgreSQL 18.6 and historical validators.\n`);
}).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });

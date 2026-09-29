const {spawnSync} = require("node:child_process");
const {checkPostgres18_6} = require("../dist/src/pg-schema.js");

function queryWithPsql(text, params) {
    if (params.length !== 0) {
        throw new Error("integration adapter only accepts parameter-free queries");
    }
    const run = spawnSync(
        "psql",
        [
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--set",
            "ON_ERROR_STOP=1",
            "--command",
            text,
        ],
        {
            env: process.env,
            encoding: "utf8",
        },
    );
    if (run.error) throw run.error;
    if (run.status !== 0) {
        throw new Error((run.stderr || run.stdout || `psql exited ${run.status}`).trim());
    }
    const values = run.stdout
        .split(/\r?\n/u)
        .map((one) => one.trim())
        .filter(Boolean);
    return {
        rows: values.map((serverVersionNum) => ({server_version_num: serverVersionNum})),
        rowCount: values.length,
    };
}

async function main() {
    const session = {query: queryWithPsql};
    const result = await checkPostgres18_6(session);
    if (!result.ok) {
        throw new Error(`PostgreSQL 18.6 integration failed: ${JSON.stringify(result.problems)}`);
    }
    if (result.value.serverVersionNum !== 180006) {
        throw new Error(`unexpected server_version_num ${result.value.serverVersionNum}`);
    }
    process.stdout.write("PostgreSQL 18.6 integration verified (server_version_num=180006)\n");
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});

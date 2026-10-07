const {spawn} = require("node:child_process");
const {createInterface} = require("node:readline");

const NULL_MARKER = "__SD_NULL__";

function sqlLiteral(value) {
    if (value === null) return "NULL";
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("non-finite PostgreSQL integration parameter");
        return String(value);
    }
    if (value instanceof Uint8Array) return `decode('${Buffer.from(value).toString("hex")}', 'hex')`;
    if (typeof value !== "string") throw new TypeError(`unsupported PostgreSQL integration parameter: ${typeof value}`);
    return `'${value.replaceAll("'", "''")}'`;
}

function bindSql(text, values) {
    return text.replace(/\$(\d+)/gu, (_whole, rawIndex) => {
        const index = Number(rawIndex) - 1;
        if (index < 0 || index >= values.length) throw new Error(`missing SQL parameter $${rawIndex}`);
        return sqlLiteral(values[index]);
    });
}

function parseCsvLine(line) {
    const result = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quoted) {
            if (char === '"' && line[index + 1] === '"') {
                value += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                value += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            result.push(value);
            value = "";
        } else {
            value += char;
        }
    }
    result.push(value);
    return result;
}

function parsePgArray(value) {
    if (value === "{}") return [];
    if (!value.startsWith("{") || !value.endsWith("}")) return value;
    const body = value.slice(1, -1);
    if (body === "") return [];
    return parseCsvLine(body).map((one) => one === "NULL" ? null : one);
}

function isCommandStatus(line) {
    return /^(?:BEGIN|COMMIT|ROLLBACK|SET|CREATE|ALTER|DROP|UPDATE \d+|DELETE \d+|INSERT \d+ \d+)$/u.test(line.trim());
}

function rowsFromCsv(lines, decodeValue = (_column, value) => value) {
    const data = lines.filter((line) => line.trim() !== "" && !isCommandStatus(line));
    if (data.length < 2) return [];
    const header = parseCsvLine(data[0]);
    return data.slice(1).map((line) => {
        const values = parseCsvLine(line);
        if (values.length !== header.length) throw new Error(`unexpected psql CSV row: ${line}`);
        const row = Object.create(null);
        for (let index = 0; index < header.length; index += 1) {
            const raw = values[index];
            row[header[index]] = raw === NULL_MARKER ? null : decodeValue(header[index], raw);
        }
        return row;
    });
}

class PsqlSession {
    constructor({decodeValue = (_column, value) => value} = {}) {
        this.sequence = 0;
        this.pending = null;
        this.stderr = "";
        this.decodeValue = decodeValue;
        this.child = spawn("psql", ["--no-psqlrc", "--quiet"], {
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
        this.child.on("error", (error) => this.rejectPending(error));
        this.child.on("exit", (code) => {
            if (code !== 0) this.rejectPending(new Error((this.stderr || `psql exited ${code}`).trim()));
        });
        createInterface({input: this.child.stdout}).on("line", (line) => this.onLine(line));
        this.child.stdin.write(`\\pset format csv\n\\pset footer off\n\\pset null ${NULL_MARKER}\n`);
    }

    rejectPending(error) {
        if (this.pending !== null) {
            const pending = this.pending;
            this.pending = null;
            pending.reject(error);
        }
    }

    onLine(line) {
        const pending = this.pending;
        if (pending === null) return;
        if (line === pending.start) {
            pending.started = true;
            return;
        }
        if (!pending.started) return;
        if (line.startsWith(pending.sqlStatePrefix)) {
            pending.sqlState = line.slice(pending.sqlStatePrefix.length).trim();
            return;
        }
        if (line.startsWith(pending.rowCountPrefix)) {
            const raw = line.slice(pending.rowCountPrefix.length).trim();
            pending.rowCount = /^\d+$/u.test(raw) ? Number(raw) : null;
            return;
        }
        if (line === pending.end) {
            this.pending = null;
            if (pending.sqlState !== "00000") {
                const stderr = this.stderr.trim();
                pending.reject(new Error(stderr || `PostgreSQL query failed with SQLSTATE ${pending.sqlState ?? "unknown"}`));
                return;
            }
            try {
                pending.resolve({
                    rows: rowsFromCsv(pending.lines, this.decodeValue),
                    rowCount: pending.rowCount,
                });
            } catch (error) {
                pending.reject(error);
            }
            return;
        }
        pending.lines.push(line);
    }

    async query(text, values) {
        if (this.pending !== null) throw new Error("psql integration session does not support concurrent queries");
        const id = ++this.sequence;
        const start = `__SD_START_${id}__`;
        const end = `__SD_END_${id}__`;
        const sqlStatePrefix = `__SD_SQLSTATE_${id}__ `;
        const rowCountPrefix = `__SD_ROWCOUNT_${id}__ `;
        const sql = bindSql(text.trim().replace(/;+\s*$/u, ""), values);
        this.stderr = "";
        return new Promise((resolve, reject) => {
            this.pending = {
                start,
                end,
                sqlStatePrefix,
                rowCountPrefix,
                started: false,
                lines: [],
                sqlState: null,
                rowCount: null,
                resolve,
                reject,
            };
            this.child.stdin.write(
                `\\echo ${start}\n${sql};\n\\echo ${sqlStatePrefix}:SQLSTATE\n\\echo ${rowCountPrefix}:ROW_COUNT\n\\echo ${end}\n`,
            );
        });
    }

    async close() {
        if (this.child.exitCode === null) {
            this.child.stdin.end("\\q\n");
            await new Promise((resolve) => this.child.once("exit", resolve));
        }
    }
}

module.exports = {
    PsqlSession,
    bindSql,
    parseCsvLine,
    parsePgArray,
    rowsFromCsv,
    sqlLiteral,
};

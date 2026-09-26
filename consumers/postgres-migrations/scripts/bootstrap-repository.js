const {lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync} = require("node:fs");
const {join, resolve} = require("node:path");

const repositoryRoot = resolve(__dirname, "../../..");
const nodeModules = join(repositoryRoot, "node_modules");
const link = join(nodeModules, "system-definition");

mkdirSync(nodeModules, {recursive: true});
let existing = false;
try {
    lstatSync(link);
    existing = true;
} catch (error) {
    if (!(error && error.code === "ENOENT")) throw error;
}

if (existing) {
    let correct = false;
    try {
        correct = lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(repositoryRoot);
    } catch {
        correct = false;
    }
    if (correct) process.exit(0);
    rmSync(link, {recursive: true, force: true});
}

symlinkSync(repositoryRoot, link, process.platform === "win32" ? "junction" : "dir");

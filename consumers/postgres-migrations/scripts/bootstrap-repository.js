const {lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync} = require("node:fs");
const {join, resolve} = require("node:path");

const repositoryRoot = resolve(__dirname, "../../..");
const nodeModules = join(repositoryRoot, "node_modules");
function ensureLink(link, target) {
mkdirSync(require("node:path").dirname(link), {recursive: true});
let current;
try { current = lstatSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (current) {
    if (current.isSymbolicLink() && realpathSync(link) === realpathSync(target)) return;
    throw new Error(`Refusing to replace unexpected package at ${link}`);
}
symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}
ensureLink(join(nodeModules, "@system-definition", "postgres-migrations"), resolve(__dirname, ".."));
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

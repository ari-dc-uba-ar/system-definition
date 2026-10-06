const fs = require("node:fs");
const assert = require("node:assert/strict");

const source = fs.readFileSync("consumers/postgres-migrations/src/preparation-artifact.ts", "utf8");

assert.match(source, /decodeFileInfo as decodePackageFileInfo/);
assert.match(source, /decodeReleaseRefInfo as decodePackageReleaseRefInfo/);
assert.match(source, /decodeResourceRefInfo as decodePackageResourceRefInfo/);
assert.match(source, /return decodePackageReleaseRefInfo\(/);
assert.match(source, /return decodePackageFileInfo\(/);
assert.match(source, /const decoded = decodePackageResourceRefInfo\(/);

const releaseAdapter = source.slice(source.indexOf("function decodeRelease("), source.indexOf("function decodeFileInfo("));
assert.equal(releaseAdapter.includes("systemId"), false, "preparation must not re-own release membership");
assert.equal(releaseAdapter.includes("releaseHash"), false, "preparation must not re-own release hashes");

const fileAdapter = source.slice(source.indexOf("function decodeFileInfo("), source.indexOf("function decodeResourceRef("));
assert.equal(fileAdapter.includes("byteLength"), false, "preparation must not re-own file membership");
assert.equal(fileAdapter.includes("contentHash"), false, "preparation must not re-own file hashes");

const resourceAdapter = source.slice(source.indexOf("function decodeResourceRef("), source.indexOf("function decodeQueryRef("));
assert.equal(resourceAdapter.includes("value.name"), false, "preparation must not re-own resource names");
assert.equal(resourceAdapter.includes("value.contentHash"), false, "preparation must not re-own resource hashes");
assert.match(resourceAdapter, /expectedKind !== undefined && decoded\.value\.kind !== expectedKind/);

// F31 remains a preparation/authoring semantic invariant; package-contract reuse must not erase it.
assert.match(source, /field\.value !== null && field\.value\.side !== domain\.value\.side/);

console.log("preparation contract reuse tests passed");

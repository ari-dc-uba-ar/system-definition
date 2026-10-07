const fs = require("node:fs");
const assert = require("node:assert/strict");

const source = fs.readFileSync("consumers/postgres-migrations/src/preparation-artifact.ts", "utf8");

assert.match(source, /decodeContentRefInfo as decodePackageContentRefInfo/);
assert.match(source, /decodeFileResourceInfo as decodePackageFileResourceInfo/);
assert.match(source, /decodeReleaseRefInfo as decodePackageReleaseRefInfo/);
assert.match(source, /decodeResourceRefInfo as decodePackageResourceRefInfo/);
assert.match(source, /return decodePackageReleaseRefInfo\(/);
assert.match(source, /const decoded = decodePackageResourceRefInfo\(/);

const releaseAdapter = source.slice(source.indexOf("function decodeRelease("), source.indexOf("function decodeResourceRef("));
assert.equal(releaseAdapter.includes("systemId"), false, "preparation must not re-own release membership");
assert.equal(releaseAdapter.includes("releaseHash"), false, "preparation must not re-own release hashes");

const resourceAdapter = source.slice(source.indexOf("function decodeResourceRef("), source.indexOf("function decodeQueryRef("));
assert.equal(resourceAdapter.includes("value.name"), false, "preparation must not re-own resource names");
assert.equal(resourceAdapter.includes("value.contentHash"), false, "preparation must not re-own resource hashes");
assert.match(resourceAdapter, /expectedKind !== undefined && decoded\.value\.kind !== expectedKind/);

const queryRefAdapter = source.slice(source.indexOf("function decodeQueryRef("), source.indexOf("function decodeFieldRef("));
assert.match(queryRefAdapter, /return decodePackageContentRefInfo\(/);
assert.equal(queryRefAdapter.includes("contentHash"), false, "preparation must not re-own query reference hashes");

const fileResourceAdapters = source.slice(source.indexOf("function decodeResources("), source.indexOf("function decodeSteps("));
assert.equal(fileResourceAdapters.includes("byteLength"), false, "preparation must not re-own file byte length membership");
assert.equal(fileResourceAdapters.includes("contentHash"), false, "preparation must not re-own file hash membership");
assert.equal(fileResourceAdapters.includes("rawResource.file"), false, "resource file membership belongs to the package codec");
assert.equal(fileResourceAdapters.includes("rawQuery.file"), false, "query file membership belongs to the package codec");
assert.equal((fileResourceAdapters.match(/decodePackageFileResourceInfo\(/g) || []).length, 2);

// F31 remains a preparation/authoring semantic invariant; package-contract reuse must not erase it.
assert.match(source, /field\.value !== null && field\.value\.side !== domain\.value\.side/);

console.log("preparation contract reuse tests passed");

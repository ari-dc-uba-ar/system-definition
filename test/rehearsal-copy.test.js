"use strict";

const assert = require("node:assert/strict");
const {
  decodeRehearsalCopyRef,
  hasWellFormedRehearsalCopyIdentity,
  sameRehearsalCopyRef,
} = require("../.verify-dist/consumers/postgres-migrations/src/rehearsal-copy.js");

const hash = "a".repeat(64);
const valid = {
  copyId: "copy-1",
  provenance: "snapshot-1",
  installationId: "install-1",
  source: {systemId: "system", releaseId: "release", releaseHash: hash},
  schemas: ["app", "audit"],
};
const invalid = (path, reason) => ({ok: false, problems: [{path, reason}]});

const decoded = decodeRehearsalCopyRef(valid, "$", invalid);
assert.equal(decoded.ok, true);
assert.notEqual(decoded.value, valid);
assert.notEqual(decoded.value.source, valid.source);
assert.notEqual(decoded.value.schemas, valid.schemas);

assert.equal(decodeRehearsalCopyRef({...valid, extra: true}, "$", invalid).ok, false);
assert.equal(decodeRehearsalCopyRef({...valid, schemas: ["app", "app"]}, "$", invalid).ok, false);
assert.equal(decodeRehearsalCopyRef({...valid, source: {...valid.source, releaseHash: "bad"}}, "$", invalid).ok, false);

assert.equal(sameRehearsalCopyRef(valid, {...valid, schemas: ["app", "audit"]}), true);
assert.equal(sameRehearsalCopyRef(valid, {...valid, schemas: ["audit", "app"]}), false);

// Typed preflight refinement is intentionally narrower than external decoding.
const typedButBadSource = {...valid, source: {systemId: "", releaseId: "", releaseHash: "bad"}};
assert.equal(hasWellFormedRehearsalCopyIdentity(typedButBadSource), true);
assert.equal(decodeRehearsalCopyRef(typedButBadSource, "$", invalid).ok, false);
assert.equal(hasWellFormedRehearsalCopyIdentity({...valid, copyId: ""}), false);
assert.equal(hasWellFormedRehearsalCopyIdentity({...valid, schemas: ["app", "app"]}), false);

const preflightSource = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "../consumers/postgres-migrations/src/preparation-preflight.ts"),
  "utf8",
);
assert.equal(preflightSource.includes("decodeRehearsalCopyRef"), false);
assert.equal(preflightSource.includes("hasWellFormedRehearsalCopyIdentity"), true);

console.log("rehearsal-copy tests passed");

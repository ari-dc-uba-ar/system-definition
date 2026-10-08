const assert = require("node:assert/strict");
const {quotePgIdentifier, quotePgQualified} = require("../consumers/postgres-migrations/dist/src/pg-sql.js");
const {buildSourceSelection} = require("../consumers/postgres-migrations/dist/src/source-selection.js");

assert.equal(quotePgIdentifier('a"b'), '"a""b"');
assert.equal(quotePgQualified("public", "users"), '"public"."users"');
assert.throws(() => quotePgIdentifier("bad\0name"), /cannot contain NUL/);

const context = {
    from: {
        entities: {
            users: {fields: {id: {type: "id", nullable: false}}},
        },
    },
};
const def = () => ({
    queryName: "users-source",
    schema: "public",
    base: {entity: "users", alias: "u"},
    joins: [],
    ports: {id: {alias: "u", field: "id"}},
    identity: ["id"],
    coverageChecks: [],
});

const valid = buildSourceSelection(context, def());
assert.equal(valid.ok, true);
assert.match(valid.value.sql, /FROM "public"\."users" AS "u"/);
assert.match(valid.value.sql, /"u"\."id" AS "id"/);

const badSchema = def();
badSchema.schema = "pub\0lic";
let result = buildSourceSelection(context, badSchema);
assert.equal(result.ok, false);
assert.equal(result.problems[0].messageKey, "migration.authoringInvalid");
assert.equal(result.problems[0].details.reason, "schema must be a valid PostgreSQL identifier");

const badAlias = def();
badAlias.base.alias = "u\0";
result = buildSourceSelection(context, badAlias);
assert.equal(result.ok, false);
assert.equal(result.problems[0].details.reason, "base entity and alias must be valid PostgreSQL identifiers");

const badField = def();
badField.ports.id.field = "id\0";
result = buildSourceSelection(context, badField);
assert.equal(result.ok, false);
assert.equal(result.problems[0].details.reason, "source field alias and field must be valid PostgreSQL identifiers");

console.log("PostgreSQL quoting tests passed");

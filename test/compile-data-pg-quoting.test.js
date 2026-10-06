const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {compileDataMigration} = require('../.verify-dist/consumers/postgres-migrations/src/compile-data.js');

function hash(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fixture(identity = 'id"quoted', schema = 'public') {
    const sourceText = 'SELECT 1';
    const transformText = 'SELECT 1';
    const sourceRef = {kind: 'query', name: 'source', contentHash: hash(sourceText)};
    const transformRef = {kind: 'query', name: 'transform', contentHash: hash(transformText)};
    const migration = {
        id: 'm1',
        transformation: 't1',
        source: {
            query: sourceRef,
            identity: [identity],
            ports: {[identity]: {domain: {nullable: false}}},
        },
        writes: [],
        arguments: {},
        conservationChecks: [],
    };
    const context = {
        migrationId: 'migration-1',
        schema,
        transformation: {
            name: 't1',
            version: '1',
            mode: 'row',
            lineage: null,
            query: transformRef,
            parameters: {},
        },
        sourceQuery: {ref: sourceRef, text: sourceText},
        transformationQuery: {ref: transformRef, text: transformText},
        lineageQuery: null,
        relationRewriter: {rewrite: ({sql}) => ({ok: true, value: sql})},
    };
    return {migration, context};
}

{
    const {migration, context} = fixture();
    const result = compileDataMigration(migration, context);
    assert.equal(result.ok, true);
    const capture = result.value.statements.find(one => one.phase === 'capture');
    assert.ok(capture);
    assert.match(capture.text, /ORDER BY "id""quoted"/);
}

for (const [identity, schema, role] of [
    ['bad\0id', 'public', 'source identity'],
    ['id', 'bad\0schema', 'schema'],
]) {
    const {migration, context} = fixture(identity, schema);
    let result;
    assert.doesNotThrow(() => { result = compileDataMigration(migration, context); });
    assert.equal(result.ok, false);
    assert.equal(result.problems[0].messageKey, 'migration.dataCompilationInvalid');
    assert.equal(result.problems[0].details.reason, 'PostgreSQL identifier contains NUL');
    assert.equal(result.problems[0].details.role, role);
}

console.log('compile-data PostgreSQL quoting tests passed');

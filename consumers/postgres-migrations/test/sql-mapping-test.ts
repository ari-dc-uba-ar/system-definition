import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import {boxType, captureSystemSnapshot, commonTypeBehaviours, completeCoreField, defineEntities, defineEntity, defineRecord, defineTypes, sqlTypes, withRecords,
    type PersistenceInfo, type SqlType, type SqlTypeMapping, type ValidationResult} from "system-definition";
import {decodeSqlSsot, projectSsotSchema, type SqlSsotInfo} from "../src/sql-mapping";
import {generateMigrationSql} from "../src/generate-migration";
import {generateStructureSql} from "../src/generate-structure";
import {generateCreate} from "../src/generate-create";
import {inferStructureChanges} from "../src/infer";
import type {AuthoringBaseInfo, FieldRefInfo, StructureChangeInfo} from "../src/authoring-contract";
import type {PgSchemaInfo} from "../src/pg-schema";
import type {StructureSql} from "../src/generate-structure";

const types = defineTypes({types: {age: {tsType: boxType<number>()}}, behaviours: {age: commonTypeBehaviours.integer}, completeField: completeCoreField});
const context = withRecords(types, {person: defineRecord(types, {id: {type: "age", nullable: false}})});
const entities = defineEntities({people: defineEntity(context, {name: "people", record: "person", pk: ["id"], fks: {}, uks: {}, validators: []})});
const captured = captureSystemSnapshot(context, {systemId: "people", entities});
if (!captured.ok) throw new Error(JSON.stringify(captured.problems));
const ssot = captured.value;
const mapping = {age: sqlTypes.smallint} satisfies SqlTypeMapping<typeof ssot>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type MappingKeys = Expect<Equal<keyof SqlTypeMapping<typeof ssot>, "age">>;
type RejectMissing = Expect<Equal<IsAssignable<{}, SqlTypeMapping<typeof ssot>>, false>>;
type RejectUnknownSql = Expect<Equal<IsAssignable<{age: "imaginary"}, SqlTypeMapping<typeof ssot>>, false>>;
type SqlChoices = Expect<Equal<SqlType, typeof sqlTypes[keyof typeof sqlTypes]>>;
type DecoderContract = Expect<Equal<typeof decodeSqlSsot, (value: unknown, mapping: unknown) => ValidationResult<SqlSsotInfo>>>;
type RejectUnrestrictedMapping = Expect<Equal<IsAssignable<{ssot: typeof ssot; persistence: PersistenceInfo}, SqlSsotInfo>, false>>;
const contracts: [MappingKeys, RejectMissing, RejectUnknownSql, SqlChoices, DecoderContract, RejectUnrestrictedMapping] = [true, true, true, true, true, true];
type GeneratorContract = Expect<Equal<typeof generateMigrationSql, (changes: readonly StructureChangeInfo[], current: PgSchemaInfo, target: SqlSsotInfo, schema: string, destinations?: readonly FieldRefInfo[]) => ValidationResult<readonly StructureSql[]>>>;
const generatorContract: GeneratorContract = true;

function value<T>(result: ValidationResult<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value; }
const system = value(decodeSqlSsot(ssot, mapping));
const empty: PgSchemaInfo = {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects: []};
const base: AuthoringBaseInfo = {
    from: {systemId: "people", releaseId: "A", releaseHash: "1".repeat(64)}, to: {systemId: "people", releaseId: "B", releaseHash: "2".repeat(64)},
    fromSnapshotHash: "3".repeat(64), toSnapshotHash: "4".repeat(64), fromPersistenceHash: "5".repeat(64), toPersistenceHash: "6".repeat(64),
};

describe("explicit SQL mapping and pure migration rendering", () => {
    it("requires a mapping for every backend type and uses only defined SQL choices", () => {
        assert.deepEqual(contracts, [true, true, true, true, true, true]);
        for (const invalid of [undefined, {}, {age: "constructor"}, {age: "int4; DROP TABLE people"}, {...mapping, other: sqlTypes.text}]) {
            assert.equal(decodeSqlSsot(ssot, invalid).ok, false);
        }
    });
    it("maps a custom domain by the supplied SQL type, without matching its name or TypeScript type", () => {
        const desired = value(projectSsotSchema(system, "app"));
        const column = desired.objects.find(object => object.kind === "column");
        assert.ok(column?.kind === "column");
        assert.equal(column.type.name, "int2");
        const different = value(decodeSqlSsot(ssot, {age: sqlTypes.bigint}));
        assert.equal(value(projectSsotSchema(different, "app")).tables[0]?.columns[0]?.type.name, "int8");
    });
    it("renders the approved differences as SQL with no database, history or release execution", () => {
        assert.equal(generatorContract, true);
        const desired = value(projectSsotSchema(system, "app"));
        const changes = value(inferStructureChanges(base, empty, desired, []));
        const before = JSON.stringify({empty, system, changes});
        const statements = value(generateMigrationSql(changes, empty, system, "app"));
        assert.ok(statements.some(statement => statement.text === 'CREATE TABLE "app"."people" ();\n'));
        assert.ok(statements.some(statement => statement.text.includes('ADD COLUMN "id" "pg_catalog"."int2" NOT NULL')));
        assert.ok(statements.some(statement => statement.text.includes('PRIMARY KEY ("id")')));
        assert.equal(JSON.stringify({empty, system, changes}), before);
    });
    it("uses the target's explicit mapping when rendering a column type change", () => {
        const current = value(projectSsotSchema(system, "app"));
        const target = value(decodeSqlSsot(ssot, {age: sqlTypes.bigint}));
        const desired = value(projectSsotSchema(target, "app"));
        const changes = value(inferStructureChanges(base, current, desired, []));
        assert.equal(changes.length, 1);
        const statements = value(generateMigrationSql(changes, current, target, "app"));
        assert.equal(statements.length, 1);
        assert.match(statements[0]!.text, /TYPE "pg_catalog"\."int8"/);
    });
    it("uses the same column default definition for initial and incremental SQL", () => {
        const schema = structuredClone(value(projectSsotSchema(system, "app")));
        const column = schema.objects.find(object => object.kind === "column");
        assert.ok(column?.kind === "column");
        column.defaultExpression = "1";
        assert.ok(value(generateCreate(schema)).statements.some(statement => statement.text.includes('DEFAULT 1 NOT NULL')));
        const changes = value(inferStructureChanges(base, empty, schema, []));
        assert.ok(value(generateStructureSql(changes, empty, schema)).some(statement => statement.text.includes('DEFAULT 1 NOT NULL')));
    });
    it("renders renamed column attributes and defers only NOT NULL for a typed data destination", () => {
        const schema = value(projectSsotSchema(system, "app"));
        const column = schema.objects.find(object => object.kind === "column");
        assert.ok(column?.kind === "column");
        const legacy = {...column, identity: {...column.identity, name: "legacy"}, nullable: true};
        const changed = {...legacy, identity: {...legacy.identity, name: 'new"code'}, nullable: false, defaultExpression: "7", type: {...column.type, name: "int8"}};
        const from = {...schema, objects: [...schema.objects, legacy]}, to = {...schema, objects: [...schema.objects, changed]};
        const changes = value(inferStructureChanges(base, from, to, [{before: {side: "from", entity: "people", field: "legacy"}, after: {side: "to", entity: "people", field: 'new"code'}}]));
        const statements = value(generateStructureSql(changes, from, to, [{side: "to", entity: "people", field: 'new"code'}]));
        assert.match(statements[0]!.text, /RENAME COLUMN "legacy" TO "new""code"/);
        assert.ok(statements.some(statement => /TYPE "pg_catalog"\."int8"/.test(statement.text) && statement.order < 50));
        assert.ok(statements.some(statement => /SET DEFAULT 7/.test(statement.text) && statement.order < 50));
        assert.ok(statements.some(statement => /SET NOT NULL/.test(statement.text) && statement.order >= 50));
        assert.equal(statements.length, 4);
    });
    it("drops an old key before modifying its columns and recreates it with explicit timing", () => {
        const current = value(projectSsotSchema(system, "app"));
        const column = current.objects.find(object => object.kind === "column"), key = current.objects.find(object => object.kind === "constraint");
        assert.ok(column?.kind === "column" && key?.kind === "constraint");
        const other = {...column, identity: {...column.identity, name: "other"}};
        const replaced = {...key, columns: ["other"], definition: 'PRIMARY KEY ("other") DEFERRABLE INITIALLY DEFERRED', deferrable: true, initiallyDeferred: true};
        const target = {...current, objects: [...current.objects.filter(object => object !== key), other, replaced]};
        const statements = value(generateStructureSql(value(inferStructureChanges(base, current, target, [])), current, target));
        assert.match(statements[0]!.text, /DROP CONSTRAINT/);
        assert.match(statements.at(-1)!.text, /PRIMARY KEY \("other"\) DEFERRABLE INITIALLY DEFERRED/);
    });
    it("uses the renamed table when removing one of its columns", () => {
        const current = value(projectSsotSchema(system, "app"));
        const column = current.objects.find(object => object.kind === "column");
        assert.ok(column?.kind === "column");
        const from = {...current, objects: [...current.objects, {...column, identity: {...column.identity, name: "legacy"}}]};
        const to = {...current, objects: current.objects.map(object => ({...object, identity: {...object.identity,
            name: object.kind === "table" ? "renamed" : object.identity.name,
            parentName: object.kind === "table" ? null : "renamed"}}))};
        const statements = value(generateStructureSql(value(inferStructureChanges(base, from, to, [{before: {entity: "people"}, after: {entity: "renamed"}}])), from, to));
        assert.match(statements[0]!.text, /"people" RENAME TO "renamed"/);
        assert.match(statements.at(-1)!.text, /ALTER TABLE "app"\."renamed" DROP COLUMN "legacy"/);
    });
    it("rejects unsupported column attributes instead of returning incomplete SQL", () => {
        const current = value(projectSsotSchema(system, "app")), target = structuredClone(current);
        const column = target.objects.find(object => object.kind === "column");
        assert.ok(column?.kind === "column");
        column.type.name = "int8";
        column.generatedDefinition = "id + 1";
        const changes = value(inferStructureChanges(base, current, target, []));
        assert.equal(generateStructureSql(changes, current, target).ok, false);
        assert.equal(generateCreate(target).ok, false);
        const unsupportedConstraint = structuredClone(current);
        const key = unsupportedConstraint.objects.find(object => object.kind === "constraint");
        assert.ok(key?.kind === "constraint");
        key.validated = false;
        assert.equal(generateCreate(unsupportedConstraint).ok, false);
    });
});

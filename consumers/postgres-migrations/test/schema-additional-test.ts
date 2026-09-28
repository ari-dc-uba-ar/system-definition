import {strict as assert} from "node:assert";
import {describe, it} from "mocha";
import type {ResourceRefInfo} from "system-definition";
import type {ManagedDataInfo} from "../src/artifact";
import {compareSchemas} from "../src/compare-schema";
import {
    prepareCreateResources,
    validateExpectedObjects,
} from "../src/create-resources";
import {inspectSchema, type InspectionInfo} from "../src/inspect-schema";
import {checkManagedData} from "../src/managed-data";
import type {
    CreateResourceInfo,
    PgObjectIdentity,
    PgObjectInfo,
    PgSchemaInfo,
    PgSession,
    SqlParameter,
    StorageContext,
} from "../src/pg-schema";
import type {ValidationResult} from "system-definition";

const prepareCreateResourcesContract: (storage: StorageContext) => ValidationResult<readonly CreateResourceInfo[]> = prepareCreateResources;
const validateExpectedObjectsContract: (resources: readonly CreateResourceInfo[], inspection: InspectionInfo) => ValidationResult<true> = validateExpectedObjects;
const checkManagedDataContract: (session: PgSession, managed: readonly ManagedDataInfo[]) => Promise<ValidationResult<true>> = checkManagedData;

type CatalogRow = Readonly<Record<string, unknown>>;

const SQL_HASH = "a".repeat(64);
const CHECK_HASH = "b".repeat(64);

function sqlRef(name: string): ResourceRefInfo {
    return {name, kind: "sql", contentHash: SQL_HASH};
}

function checkRef(name: string): ResourceRefInfo {
    return {name, kind: "check", contentHash: CHECK_HASH};
}

function identity(
    kind: string,
    name: string,
    parentName: string | null = null,
    signature: readonly string[] = [],
): PgObjectIdentity {
    return {schema: "app", kind, name, parentName, signature};
}

const viewIdentity = identity("view", "active_students");
const routineIdentity = identity("routine", "normalize_email", null, ["text"]);
const checkIdentity = identity("constraint", "settings_value_check", "settings");
const indexIdentity = identity("index", "settings_value_idx", "settings");

function storage(createResources: readonly CreateResourceInfo[]): StorageContext {
    return {
        representation: "postgres",
        physicalTypes: {},
        schema: "app",
        environment: {
            engine: "postgresql",
            version: "18.6",
            serverVersionNum: 180006,
            encoding: "UTF8",
            collations: {},
            externalDependencies: {},
        },
        resources: {
            create_view: {ref: sqlRef("create_view"), text: "CREATE VIEW ..."},
            create_routine: {ref: sqlRef("create_routine"), text: "CREATE FUNCTION ..."},
            create_constraint: {ref: sqlRef("create_constraint"), text: "ALTER TABLE ..."},
            create_index: {ref: sqlRef("create_index"), text: "CREATE INDEX ..."},
            release_check: {ref: checkRef("release_check"), text: "SELECT true AS ok"},
        },
        createResources,
        managedData: [],
        invariantChecks: [checkRef("release_check")],
    };
}

function catalogRows(): CatalogRow[] {
    const base = {
        persistence: null,
        relation_kind: null,
        type_schema: null,
        type_name: null,
        type_modifiers: [],
        array_dimensions: null,
        collation: null,
        nullable: null,
        default_expression: null,
        identity_definition: null,
        generated_definition: null,
        constraint_kind: null,
        target_schema: null,
        target_name: null,
        pairs: [],
        deferrable: null,
        initially_deferred: null,
        validated: null,
        enforced: null,
        valid: null,
        ready: null,
        owner_constraint_schema: null,
        owner_constraint_name: null,
        owner_constraint_parent: null,
        options: null,
        routine_kind: null,
        feature: null,
    } as const;
    return [
        {
            ...base,
            object_kind: "view",
            schema_name: "app",
            object_name: "active_students",
            parent_name: null,
            signature: [],
            definition: "SELECT alumnos.id FROM app.alumnos WHERE alumnos.active",
            columns: ["id"],
            options: {security_barrier: "false", check_option: "NONE"},
        },
        {
            ...base,
            object_kind: "routine",
            schema_name: "app",
            object_name: "normalize_email",
            parent_name: null,
            signature: ["text"],
            definition: "CREATE FUNCTION app.normalize_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT lower($1)'",
            columns: [],
            routine_kind: "function",
        },
        {
            ...base,
            object_kind: "constraint",
            schema_name: "app",
            object_name: "settings_value_check",
            parent_name: "settings",
            signature: [],
            constraint_kind: "check",
            definition: "CHECK (value <> ''::text)",
            columns: [],
            pairs: [],
            deferrable: false,
            initially_deferred: false,
            validated: true,
            enforced: true,
        },
        {
            ...base,
            object_kind: "index",
            schema_name: "app",
            object_name: "settings_value_idx",
            parent_name: "settings",
            signature: [],
            definition: "CREATE INDEX settings_value_idx ON app.settings USING btree (value)",
            columns: [],
            valid: true,
            ready: true,
        },
        {
            ...base,
            object_kind: "constraint",
            schema_name: "app",
            object_name: "settings_pkey",
            parent_name: "settings",
            signature: [],
            constraint_kind: "primaryKey",
            definition: "PRIMARY KEY (name)",
            columns: ["name"],
            pairs: [],
            deferrable: false,
            initially_deferred: false,
            validated: true,
            enforced: true,
        },
        {
            ...base,
            object_kind: "index",
            schema_name: "app",
            object_name: "settings_pkey",
            parent_name: "settings",
            signature: [],
            definition: "CREATE UNIQUE INDEX settings_pkey ON app.settings USING btree (name)",
            columns: [],
            valid: true,
            ready: true,
            owner_constraint_schema: "app",
            owner_constraint_name: "settings_pkey",
            owner_constraint_parent: "settings",
        },
    ];
}

class CatalogSession implements PgSession {
    readonly queries: {text: string; values: readonly SqlParameter[]}[] = [];
    constructor(private readonly rows: readonly CatalogRow[]) {}
    async query(text: string, values: readonly SqlParameter[]) {
        this.queries.push({text, values});
        return {rows: this.rows, rowCount: this.rows.length};
    }
    async close(): Promise<void> {}
}

class ManagedDataSession implements PgSession {
    readonly queries: {text: string; values: readonly SqlParameter[]}[] = [];
    constructor(private readonly rows: readonly Readonly<Record<string, unknown>>[]) {}
    async query(text: string, values: readonly SqlParameter[]) {
        this.queries.push({text, values});
        return {rows: this.rows, rowCount: this.rows.length};
    }
    async close(): Promise<void> {}
}

function schemaFrom(objects: readonly PgObjectInfo[]): PgSchemaInfo {
    return {formatVersion: 1, engineVersion: "18.6", schemas: ["app"], objects};
}

function inspection(schema: PgSchemaInfo, unknown: InspectionInfo["unknown"] = []): InspectionInfo {
    return {schema, unknown, excluded: []};
}

describe("additional PostgreSQL objects and managed metadata", function(){
    it("orders declared create resources topologically with stable id tie-breaking and rejects invalid graphs", function(){
        const resources: readonly CreateResourceInfo[] = [
            {id: "view", run: sqlRef("create_view"), dependsOn: ["routine"], expectedObjects: [viewIdentity]},
            {id: "index", run: sqlRef("create_index"), dependsOn: [], expectedObjects: [indexIdentity]},
            {id: "routine", run: sqlRef("create_routine"), dependsOn: [], expectedObjects: [routineIdentity]},
        ];
        const ordered = prepareCreateResourcesContract(storage(resources));
        assert.equal(ordered.ok, true);
        if (!ordered.ok) return;
        assert.deepEqual(ordered.value.map(one => one.id), ["index", "routine", "view"]);

        const cycle = prepareCreateResourcesContract(storage([
            {...resources[0], dependsOn: ["routine"]},
            {...resources[2], dependsOn: ["view"]},
        ]));
        assert.equal(cycle.ok, false);
        const missing = prepareCreateResourcesContract(storage([
            {...resources[0], dependsOn: ["not-there"]},
        ]));
        assert.equal(missing.ok, false);
        const duplicate = prepareCreateResourcesContract(storage([resources[0], resources[0]]));
        assert.equal(duplicate.ok, false);
    });

    it("inspects views/routines/checks/indexes with server definitions and detects semantic body changes", async function(){
        const session = new CatalogSession(catalogRows());
        const actual = await inspectSchema(session, {schemas: ["app"], excluded: []});
        assert.equal(actual.ok, true);
        if (!actual.ok) return;
        assert.equal(session.queries.length, 1);
        assert.match(session.queries[0].text, /pg_get_viewdef/i);
        assert.match(session.queries[0].text, /pg_get_functiondef/i);

        const view = actual.value.schema.objects.find(one => one.kind === "view");
        const routine = actual.value.schema.objects.find(one => one.kind === "routine");
        const check = actual.value.schema.objects.find(one => one.kind === "constraint" && one.constraintKind === "check");
        const independent = actual.value.schema.objects.find(one => one.kind === "index" && one.identity.name === "settings_value_idx");
        assert.ok(view && routine && check && independent);

        const changedObjects = actual.value.schema.objects.map(one => one.kind === "routine"
            ? {...one, definition: one.definition.replace("lower($1)", "upper($1)")}
            : one);
        const comparison = compareSchemas(schemaFrom(actual.value.schema.objects), inspection(schemaFrom(changedObjects)));
        assert.equal(comparison.ok, true);
        if (!comparison.ok) return;
        assert.equal(comparison.value.equal, false);
        assert.ok(comparison.value.differences.some(one => one.path.includes("normalize_email") && one.path.at(-1) === "definition"));
    });

    it("validates expected resource objects without treating a constraint backing index as a second authored object", async function(){
        const inspected = await inspectSchema(new CatalogSession(catalogRows()), {schemas: ["app"], excluded: []});
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;

        const resources: readonly CreateResourceInfo[] = [
            {id: "constraint", run: sqlRef("create_constraint"), dependsOn: [], expectedObjects: [checkIdentity]},
            {id: "index", run: sqlRef("create_index"), dependsOn: [], expectedObjects: [indexIdentity]},
            {id: "routine", run: sqlRef("create_routine"), dependsOn: [], expectedObjects: [routineIdentity]},
            {id: "view", run: sqlRef("create_view"), dependsOn: ["routine"], expectedObjects: [viewIdentity]},
        ];
        const validated = validateExpectedObjectsContract(resources, inspected.value);
        assert.equal(validated.ok, true);

        const missingView = inspection(schemaFrom(inspected.value.schema.objects.filter(one => one.kind !== "view")));
        assert.equal(validateExpectedObjectsContract(resources, missingView).ok, false);

        const unsupported = inspection(inspected.value.schema, [{object: identity("trigger", "audit", "settings"), feature: "trigger"}]);
        assert.equal(validateExpectedObjectsContract(resources, unsupported).ok, false);
    });

    it("reports extra independent objects but does not duplicate constraint-owned backing indexes in authored coverage", async function(){
        const inspected = await inspectSchema(new CatalogSession(catalogRows()), {schemas: ["app"], excluded: []});
        assert.equal(inspected.ok, true);
        if (!inspected.ok) return;

        const backing = inspected.value.schema.objects.find(one => one.kind === "index" && one.identity.name === "settings_pkey");
        assert.ok(backing && backing.kind === "index" && backing.ownerConstraint !== null);

        const withoutIndependent = inspected.value.schema.objects.filter(one => !(one.kind === "index" && one.identity.name === "settings_value_idx"));
        const drift = compareSchemas(schemaFrom(withoutIndependent), inspected.value);
        assert.equal(drift.ok, true);
        if (!drift.ok) return;
        assert.equal(drift.value.equal, false);
        assert.ok(drift.value.differences.some(one => one.change === "add" && one.path.includes("settings_value_idx")));
    });

    it("checks only declared managed rows/columns, keeps null distinct from empty string, and rejects duplicate keys", async function(){
        const declaration: ManagedDataInfo = {
            table: {schema: "app", name: "settings"},
            key: ["name"],
            columns: ["name", "value"],
            rows: [
                {name: "mode", value: "strict"},
                {name: "nullable", value: null},
                {name: "empty", value: ""},
            ],
        };
        const session = new ManagedDataSession([
            {name: "mode", value: "strict"},
            {name: "nullable", value: null},
            {name: "empty", value: ""},
        ]);
        const checked = await checkManagedDataContract(session, [declaration]);
        assert.equal(checked.ok, true);
        assert.ok(session.queries.length >= 1);
        assert.ok(session.queries.every(one => !/select\s+\*/i.test(one.text)));

        const wrong = await checkManagedDataContract(new ManagedDataSession([
            {name: "mode", value: "loose"},
            {name: "nullable", value: null},
            {name: "empty", value: ""},
        ]), [declaration]);
        assert.equal(wrong.ok, false);

        const duplicate: ManagedDataInfo = {
            ...declaration,
            rows: [{name: "mode", value: "strict"}, {name: "mode", value: "other"}],
        };
        assert.equal((await checkManagedDataContract(new ManagedDataSession([]), [duplicate])).ok, false);

        const missingKeyColumn: ManagedDataInfo = {...declaration, columns: ["value"]};
        assert.equal((await checkManagedDataContract(new ManagedDataSession([]), [missingKeyColumn])).ok, false);
    });
});

import type {ValidationResult} from "system-definition";
import type {PgObjectIdentity, PgSchemaInfo, PgSession} from "../src/pg-schema";
import {
    inspectSchema,
    type InspectionInfo,
    type InspectionScope,
} from "../src/inspect-schema";
import {
    compareSchemas,
    type SchemaComparisonInfo,
    type SchemaDifferenceInfo,
} from "../src/compare-schema";

const _inspect: (
    session: PgSession,
    scope: InspectionScope,
) => Promise<ValidationResult<InspectionInfo>> = inspectSchema;

const _compare: (
    expected: PgSchemaInfo,
    actual: InspectionInfo,
) => ValidationResult<SchemaComparisonInfo> = compareSchemas;

const excludedObject: PgObjectIdentity = {
    schema: "app",
    kind: "index",
    name: "external_idx",
    parentName: "items",
    signature: [],
};

const scope: InspectionScope = {
    schemas: ["app"],
    excluded: [{object: excludedObject, reason: "declared external dependency"}],
};

const difference: SchemaDifferenceInfo = {
    path: ["objects", "app", "column", "items", "value", "nullable"],
    change: "change",
    before: true,
    after: false,
};

const comparison: SchemaComparisonInfo = {
    equal: false,
    differences: [difference],
};

void _inspect;
void _compare;
void scope;
void comparison;

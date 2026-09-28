import type {ValidationResult} from "system-definition";
import type {ManagedDataInfo} from "../src/artifact";
import type {
    CreateResourceInfo,
    PgObjectIdentity,
    PgSession,
    StorageContext,
} from "../src/pg-schema";
import type {InspectionInfo} from "../src/inspect-schema";
import {
    prepareCreateResources,
    validateExpectedObjects,
} from "../src/create-resources";
import {checkManagedData} from "../src/managed-data";

const _prepare: (storage: StorageContext) => ValidationResult<readonly CreateResourceInfo[]> = prepareCreateResources;
const _validate: (
    resources: readonly CreateResourceInfo[],
    inspection: InspectionInfo,
) => ValidationResult<true> = validateExpectedObjects;
const _managed: (
    session: PgSession,
    managed: readonly ManagedDataInfo[],
) => Promise<ValidationResult<true>> = checkManagedData;

const expected: PgObjectIdentity = {
    schema: "app",
    kind: "view",
    name: "active_students",
    parentName: null,
    signature: [],
};

void _prepare;
void _validate;
void _managed;
void expected;

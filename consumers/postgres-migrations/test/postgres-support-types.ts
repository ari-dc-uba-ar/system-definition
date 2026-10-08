import type {EnvironmentInfo} from "../src/artifact";
import type {DeploymentBindingInfo} from "../src/evidence";
import type {PgSchemaInfo} from "../src/pg-schema";
import {POSTGRES_SUPPORT} from "../src/postgres-support";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;

type Assert<T extends true> = T;

type _EnvironmentEngine = Assert<Equal<EnvironmentInfo["engine"], typeof POSTGRES_SUPPORT.engine>>;
type _EnvironmentVersion = Assert<Equal<EnvironmentInfo["version"], typeof POSTGRES_SUPPORT.version>>;
type _EnvironmentServerVersion = Assert<Equal<EnvironmentInfo["serverVersionNum"], typeof POSTGRES_SUPPORT.serverVersionNum>>;
type _SchemaVersion = Assert<Equal<PgSchemaInfo["engineVersion"], typeof POSTGRES_SUPPORT.version>>;
type _BindingVersion = Assert<Equal<DeploymentBindingInfo["engineVersion"], typeof POSTGRES_SUPPORT.version>>;

// @ts-expect-error unsupported versions must not type-check as environment metadata
const invalidEnvironmentVersion: EnvironmentInfo["version"] = "18.7";
void invalidEnvironmentVersion;

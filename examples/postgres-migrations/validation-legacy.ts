import {createHistoricalValidation} from "@system-definition/postgres-migrations/validation";
import {legacySnapshot} from "./students";
import {studentTypes} from "./student-context";
import {contentHash} from "./support";
// No live project/runtime import: only this historical snapshot and its behaviours are bundled.
export const {abi, snapshotHash, validatePorts, validateEntityRow} = createHistoricalValidation(legacySnapshot, contentHash(legacySnapshot), studentTypes, {});

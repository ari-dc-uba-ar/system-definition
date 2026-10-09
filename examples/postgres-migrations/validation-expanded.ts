import {createHistoricalValidation} from "@system-definition/postgres-migrations/validation";
import {expandedSnapshot} from "./students";
import {studentTypes} from "./student-context";
import {contentHash} from "./support";
export const {abi, snapshotHash, validatePorts, validateEntityRow} = createHistoricalValidation(expandedSnapshot, contentHash(expandedSnapshot), studentTypes, {});

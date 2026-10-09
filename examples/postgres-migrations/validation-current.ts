import {createHistoricalValidation} from "@system-definition/postgres-migrations/validation";
import {currentSnapshot} from "./students";
import {studentTypes} from "./student-context";
import {contentHash} from "./support";
export const {abi, snapshotHash, validatePorts, validateEntityRow} = createHistoricalValidation(currentSnapshot, contentHash(currentSnapshot), studentTypes, {});

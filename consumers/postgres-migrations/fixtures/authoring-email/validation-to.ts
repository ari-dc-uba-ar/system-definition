import {createHistoricalValidation} from "../../src/historical-validation";
import {authoringEmailSnapshotB, authoringEmailBase, fixtureTypes} from "./index";

const historical = createHistoricalValidation(authoringEmailSnapshotB, authoringEmailBase.toSnapshotHash, fixtureTypes, {});
export const {abi, snapshotHash, validatePorts, validateEntityRow} = historical;

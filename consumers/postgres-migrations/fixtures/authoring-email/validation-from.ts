import {createHistoricalValidation} from "../../src/historical-validation";
import {authoringEmailSnapshotA, authoringEmailBase, fixtureTypes} from "./index";

// This entry is bundled, including the domain behaviours, before its hash is recorded.
const historical = createHistoricalValidation(authoringEmailSnapshotA, authoringEmailBase.fromSnapshotHash, fixtureTypes, {});
export const {abi, snapshotHash, validatePorts, validateEntityRow} = historical;

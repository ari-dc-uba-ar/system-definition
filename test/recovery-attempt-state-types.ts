import type {AttemptState} from "../consumers/postgres-migrations/src/journal";
import type {CommitOutcomeState} from "../consumers/postgres-migrations/src/recovery";

type Expected = Exclude<AttemptState, "running">;

declare const actual: CommitOutcomeState;
declare const expected: Expected;

const actualToExpected: Expected = actual;
const expectedToActual: CommitOutcomeState = expected;
void actualToExpected;
void expectedToActual;

// @ts-expect-error recovery outcomes are terminal attempt states only.
const runningOutcome: CommitOutcomeState = "running";
void runningOutcome;

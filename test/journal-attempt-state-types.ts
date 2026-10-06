import {
    ATTEMPT_STATE,
    ATTEMPT_STATES,
    type AttemptState,
    type PreparationAttemptState,
} from "../consumers/postgres-migrations/src/journal";

declare const attempt: AttemptState;
declare const preparation: PreparationAttemptState;

const attemptToPreparation: PreparationAttemptState = attempt;
const preparationToAttempt: AttemptState = preparation;
const allStates: readonly AttemptState[] = ATTEMPT_STATES;
const running: AttemptState = ATTEMPT_STATE.running;

void attemptToPreparation;
void preparationToAttempt;
void allStates;
void running;

// @ts-expect-error unsupported states must not enter the durable attempt vocabulary.
const invalidAttemptState: AttemptState = "ready";
void invalidAttemptState;

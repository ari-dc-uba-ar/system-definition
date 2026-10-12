import {
    ATTEMPT_STATE,
    ATTEMPT_STATES,
    type AttemptState,
} from "../src/journal";

declare const attempt: AttemptState;

const allStates: readonly AttemptState[] = ATTEMPT_STATES;
const running: AttemptState = ATTEMPT_STATE.running;

void allStates;
void running;

// @ts-expect-error unsupported states must not enter the durable attempt vocabulary.
const invalidAttemptState: AttemptState = "ready";
void invalidAttemptState;

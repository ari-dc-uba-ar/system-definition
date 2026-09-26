import type {JsonValue} from "../src/common/json-value";
import {canonicalJson, toJsonValue} from "../src/common/json-value";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

type _primitiveAccepted = Assert<IsAssignable<null | boolean | number | string, JsonValue>>;
type _readonlyArrayAccepted = Assert<IsAssignable<readonly JsonValue[], JsonValue>>;
type _readonlyObjectAccepted = Assert<IsAssignable<{readonly key: JsonValue}, JsonValue>>;
type _undefinedRejected = Assert<Not<IsAssignable<undefined, JsonValue>>>;
type _functionRejected = Assert<Not<IsAssignable<() => void, JsonValue>>>;

const result = toJsonValue({answer: 42});
if (result.ok) {
    canonicalJson(result.value);
}

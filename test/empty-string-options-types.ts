import type {ParseOptions} from "../src/common/serialize";
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
export type _OptionToBoolean = Assert<IsAssignable<ParseOptions["emptyStringIsNull"], boolean | undefined>>;
export type _BooleanToOption = Assert<IsAssignable<boolean | undefined, ParseOptions["emptyStringIsNull"]>>;
export type _RejectString = AssertFalse<IsAssignable<string, ParseOptions["emptyStringIsNull"]>>;
export type _PreserveAccepted = Assert<IsAssignable<{emptyStringIsNull: false}, ParseOptions>>;
export type _LegacyAccepted = Assert<IsAssignable<{requireMandatory: true}, ParseOptions>>;

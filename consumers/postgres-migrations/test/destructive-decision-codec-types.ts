import {
    decodeDestructiveDecisionInfo,
    type DestructiveDecisionInfo,
} from "../src/authoring-contract";
import type {StructuralFailure, ValidationResult} from "system-definition";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
    : false;
type Decoded = ReturnType<typeof decodeDestructiveDecisionInfo> extends ValidationResult<infer T> ? T : never;
const decodedIsExactlyDecision: Equal<Decoded, DestructiveDecisionInfo> = true;
void decodedIsExactlyDecision;

const invalid: StructuralFailure = (_path, _reason) => ({
    ok: false,
    problems: [{field: null, messageKey: "test", severity: "blocking", details: {}}],
});
const result = decodeDestructiveDecisionInfo({
    changeId: "change",
    source: null,
    partitionCheck: null,
    resolution: {kind: "discard", reason: "reason"},
}, "decision", invalid);
if (result.ok) {
    const forward: DestructiveDecisionInfo = result.value;
    const reverse: typeof result.value = forward;
    void reverse;
}

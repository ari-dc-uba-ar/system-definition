import {toJsonValue, type ValidationResult} from "system-definition";
import type {MigrationDraftInfo} from "./authoring-contract";
import {canonicalJsonSha256} from "./canonical-hash";

/** Hash authored choices; changes and pending are derived. */
export function computeDraftRevisionHash(draft: MigrationDraftInfo): ValidationResult<string> {
    const json = toJsonValue({
        base: draft.base, renames: draft.renames, data: draft.data,
        decisions: draft.decisions, manual: draft.manual,
    });
    return json.ok ? {ok: true, value: canonicalJsonSha256(json.value)} : json;
}

import type {ResourceRefInfo} from "system-definition";
import type {CompiledAuthoringInfo} from "./authoring-contract";

function uniqueChecks(checks: readonly ResourceRefInfo[]): readonly ResourceRefInfo[] {
    const seen = new Set<string>();
    const unique = checks.filter(ref => {
        const key = JSON.stringify([ref.kind, ref.name, ref.contentHash]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return unique.length === checks.length ? checks : unique;
}

/** Check identities can be shared within one boundary, but must run again after intervening steps. */
export function deduplicateMigrationChecks(compiled: CompiledAuthoringInfo): CompiledAuthoringInfo {
    const before = uniqueChecks(compiled.migration.before);
    const after = uniqueChecks(compiled.migration.after);
    const checkpoints = compiled.checkpoints.map(checkpoint => {
        const checks = uniqueChecks(checkpoint.checks);
        return checks === checkpoint.checks ? checkpoint : {...checkpoint, checks};
    });
    if (before === compiled.migration.before && after === compiled.migration.after
        && checkpoints.every((checkpoint, index) => checkpoint === compiled.checkpoints[index])) return compiled;
    return {...compiled, migration: {...compiled.migration, before, after}, checkpoints};
}

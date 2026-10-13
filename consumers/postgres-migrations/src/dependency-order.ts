import {compareUtf16} from "system-definition";

/** Order validated, uniquely named operations; a cycle has no complete order. */
export function orderDependencies<T extends {id: string; dependsOn: readonly string[]}>(items: readonly T[], policy: "lexical" | "layers" = "lexical"): readonly T[] | null {
    const byId = new Map(items.map(item => [item.id, item]));
    const remaining = new Map(items.map(item => [item.id, item.dependsOn.length]));
    const dependents = new Map<string, string[]>();
    for (const item of items) {
        for (const dependency of item.dependsOn) {
            const targets = dependents.get(dependency) ?? [];
            targets.push(item.id);
            dependents.set(dependency, targets);
        }
    }
    const ready = items.filter(item => item.dependsOn.length === 0).map(item => item.id).sort(compareUtf16);
    const ordered: T[] = [];
    while (ready.length > 0) {
        // Data captures keep each ready layer together; DDL/manual steps use a lexical queue.
        for (const id of ready.splice(0, policy === "layers" ? ready.length : 1)) {
            ordered.push(byId.get(id)!);
            for (const dependent of dependents.get(id) ?? []) {
                const next = remaining.get(dependent)! - 1;
                remaining.set(dependent, next);
                if (next === 0) ready.push(dependent);
            }
        }
        ready.sort(compareUtf16);
    }
    return ordered.length === items.length ? ordered : null;
}

/** Reuse ancestor sets across overlap checks on an already validated dependency graph. */
export function dependencyReachability(items: readonly {id: string; dependsOn: readonly string[]}[]): (id: string, dependency: string) => boolean {
    const byId = new Map(items.map(item => [item.id, item]));
    const memo = new Map<string, ReadonlySet<string>>();
    return (id, dependency) => {
        let ancestors = memo.get(id);
        if (ancestors === undefined) {
            const found = new Set<string>();
            const stack = [...(byId.get(id)?.dependsOn ?? [])];
            while (stack.length > 0) {
                const current = stack.pop()!;
                if (found.has(current)) continue;
                found.add(current);
                stack.push(...(byId.get(current)?.dependsOn ?? []));
            }
            memo.set(id, found);
            ancestors = found;
        }
        return ancestors.has(dependency);
    };
}

import {compareUtf16} from "system-definition";

/** Order validated, uniquely named operations; a cycle has no complete order. */
export function orderDependencies<T extends {id: string; dependsOn: readonly string[]}>(items: readonly T[]): readonly T[] | null {
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
        const id = ready.shift()!;
        ordered.push(byId.get(id)!);
        for (const dependent of dependents.get(id) ?? []) {
            const next = remaining.get(dependent)! - 1;
            remaining.set(dependent, next);
            if (next === 0) { ready.push(dependent); ready.sort(compareUtf16); }
        }
    }
    return ordered.length === items.length ? ordered : null;
}

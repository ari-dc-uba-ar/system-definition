/** Deterministic JavaScript/UTF-16 code-unit ordering for serialized names and keys. */
export function compareUtf16(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

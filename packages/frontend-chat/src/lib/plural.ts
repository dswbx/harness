/** `n` with its noun: `1 edit`, `3 edits`, `2 searches` (`many` for irregular plurals). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
